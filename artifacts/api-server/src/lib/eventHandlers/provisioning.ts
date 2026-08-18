import type { Logger } from "pino";
import { findOrCreateAgentByBotUuid } from "../backfill";
import { assignHomeIfNeeded, housingCapacity } from "../onboarding";

/**
 * Giving an arriving OCC agent its storefront and its flat.
 *
 * Vincent: "bot.created / bot.verified exist so a new agent gets its KAX
 * storefront and apartment immediately."
 *
 * THE STOREFRONT half is uncontroversial and already built. A storefront is not
 * a row — it is an `agents` row plus whatever that agent has made, rendered by
 * `/storefront/by-agent/:slug`. So `findOrCreateAgentByBotUuid()` IS storefront
 * provisioning, it is already idempotent (it returns the existing row on a bot
 * id match), and it is already race-safe. Passing the display name from the
 * event matters for a reason that is not obvious: without one, that function
 * falls through to gallery lookups that spend partner-API budget on every
 * single delivery.
 *
 * THE APARTMENT half collides with a written design decision, and the collision
 * is real rather than a misunderstanding. `lib/onboarding.ts` argues explicitly
 * that a key comes with ARRIVING rather than with existing — "eighty
 * allocatable units against three hundred-odd storefronts. Handing one to every
 * agent on the register would empty the tower before most of them ever walked
 * through the door" — which is why `assignHomeIfNeeded` had exactly one caller,
 * inside `POST /city/enter`.
 *
 * Both positions are right about different things, so this does not pick one.
 * It allocates immediately, as asked, but stops while a RESERVE of units is
 * still free (`KAX_BOT_CREATED_HOUSING_RESERVE`, default 16). The effect:
 *   - a new OCC agent gets a flat the moment it is created, which is the ask;
 *   - `/city/enter` is untouched and can always still house an agent that
 *     actually walks in, which is what the tower arithmetic was protecting;
 *   - setting the reserve to 0 gives Vincent's request with no qualification,
 *     and it is one environment variable.
 *
 * This is flagged for Nick as a product decision rather than settled here. What
 * is NOT a matter of taste is that an unbounded external event stream must not
 * be able to drain the tower: `bot.created` is unauthenticated provisioning
 * driven by another party, and the HMAC is the only thing in front of it.
 */

/** Units kept back for agents who actually walk in. */
export function housingReserve(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["KAX_BOT_CREATED_HOUSING_RESERVE"];
  if (raw !== undefined && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return 16;
}

export interface ProvisionResult {
  agentId: number;
  slug: string;
  /** True when this call created the agents row rather than finding it. */
  storefrontCreated: boolean;
  /** The unit, when the agent has one — whether or not this call assigned it. */
  home: { floor: number; letter: string } | null;
  /** True when THIS call took the unit. */
  homeAssigned: boolean;
  /** Why no flat, when there is none. */
  homeSkipped: "reserved" | "tower-full" | null;
}

/**
 * Idempotent by construction, which is what makes a redelivered `bot.created`
 * safe: `findOrCreateAgentByBotUuid` returns the existing row for a bot it has
 * already seen, and `assignHomeIfNeeded` returns the existing unit with
 * `assigned:false`. Neither creates a second anything.
 */
export async function provisionAgent(
  botId: string,
  opts: { name?: string | null; avatarUrl?: string | null; log: Logger },
): Promise<ProvisionResult> {
  // `findOrCreateAgentByBotUuid` inserts with `ownerId: KANNAKA_SYSTEM_USER_ID`
  // and `agents.owner_id` is a foreign key, so provisioning fails with a
  // constraint violation on any deployment where that placeholder user row has
  // never been created. Nothing in the harvest path creates it — it has simply
  // always been there in production — but `bot.created` is the first code path
  // that can be the very first thing to mint an agent, and an FK error here
  // answers the delivery 500 and puts OCC into a retry loop against a condition
  // that will never clear on its own. One idempotent insert removes the class.
  await ensureSystemOwner();

  const before = await agentExists(botId);
  const agent = await findOrCreateAgentByBotUuid(botId, {
    name: opts.name ?? null,
    avatarUrl: opts.avatarUrl ?? null,
  });

  const capacity = await housingCapacity();
  const reserve = housingReserve();
  if (capacity.free <= reserve) {
    // Say WHICH refusal this is. "The tower is full" and "the tower is holding
    // units back for arrivals" look identical from outside and want different
    // responses — one is a capacity problem, the other is a policy knob.
    const homeSkipped = capacity.free === 0 ? "tower-full" : "reserved";
    const existing = await currentHome(agent.id);
    opts.log.info(
      { botId, agentId: agent.id, free: capacity.free, reserve, homeSkipped },
      existing
        ? "agent provisioned; it already has a home"
        : "agent provisioned WITHOUT a flat — the tower is at its reserve",
    );
    return {
      agentId: agent.id,
      slug: agent.slug,
      storefrontCreated: !before,
      home: existing,
      homeAssigned: false,
      homeSkipped: existing ? null : homeSkipped,
    };
  }

  const unit = await assignHomeIfNeeded(agent.id);
  return {
    agentId: agent.id,
    slug: agent.slug,
    storefrontCreated: !before,
    home: unit ? { floor: unit.floor, letter: unit.letter } : null,
    homeAssigned: Boolean(unit?.assigned),
    homeSkipped: unit ? null : "tower-full",
  };
}

/** The placeholder owner every unclaimed agent row points at. Idempotent. */
async function ensureSystemOwner(): Promise<void> {
  const { db } = await import("@workspace/db");
  const { usersTable } = await import("@workspace/db/schema");
  const { KANNAKA_SYSTEM_USER_ID } = await import("../backfill");
  await db.insert(usersTable).values({ id: KANNAKA_SYSTEM_USER_ID }).onConflictDoNothing();
}

async function agentExists(botId: string): Promise<boolean> {
  const { db } = await import("@workspace/db");
  const { agentsTable } = await import("@workspace/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.obcBotId, botId))
    .limit(1);
  return Boolean(row);
}

async function currentHome(agentId: number): Promise<{ floor: number; letter: string } | null> {
  const { homeUnitOf } = await import("../onboarding");
  return homeUnitOf(agentId);
}
