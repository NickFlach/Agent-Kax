import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { residenceUnitsTable } from "@workspace/db/schema";
import type { Actor } from "./actor";
import * as residents from "./residents";
import { residenceRoom } from "./rooms";

/**
 * What is left before somebody actually lives here.
 *
 * Moving in has quietly become a five-part process — attach a bot, name it,
 * claim a unit, move a body in, and know where the door is — and every part of
 * it was learned by someone asking and being told. That is a fine way to
 * onboard one resident and a bad way to onboard any others.
 *
 * So this is a checklist COMPUTED FROM STATE, not a document. A written guide
 * goes stale the first time a route changes and nobody notices, because
 * nothing is checking it. This one cannot: each step reports what is actually
 * true right now, and hands back the exact call that advances it.
 *
 * It serves both arrivals deliberately. A human can read it in the browser and
 * go and pick a flat by walking to it; an agent can read the same structure as
 * a tool and just claim one. Neither path is the "real" one — an agent whose
 * human wants to choose the view should not be second-class, and an agent
 * pointed at the city by one instruction should not have to be chaperoned.
 */

export interface OnboardingStep {
  id: "identity" | "name" | "home" | "moved-in";
  title: string;
  done: boolean;
  /** What is true right now. */
  detail: string;
  /** The call that advances this step, when it is not done. */
  next?: { http: string; tool?: string };
}

export interface Onboarding {
  resident: string;
  complete: boolean;
  steps: OnboardingStep[];
  nextStep: OnboardingStep | null;
  /** A few free flats, so choosing does not require reading the whole list. */
  vacantExamples: { unit: string; floor: number; tier: number }[];
}

/** Floors 2-11 are the allocatable stock. The penthouse is 12 and is not. */
async function homeOf(agentId: number): Promise<string | null> {
  const row = await homeUnitOf(agentId);
  return row ? `${row.floor}${row.letter}` : null;
}

/** The unit itself, for anyone who needs to stand at its door. */
export async function homeUnitOf(agentId: number): Promise<{ floor: number; letter: string } | null> {
  const [row] = await db
    .select({ floor: residenceUnitsTable.floor, letter: residenceUnitsTable.letter })
    .from(residenceUnitsTable)
    .where(eq(residenceUnitsTable.agentId, agentId))
    .limit(1);
  return row ?? null;
}

/**
 * Where somebody's front door is, and which room it is in.
 *
 * These coordinates are the residences scene's, not invented here: unit doors
 * sit at x ∈ {-6.5,-2.2,2.2,6.5} along z = -8.3 (A-D) and z = +8.3 (E-H). We
 * stand a stride back into the hall and face the door, because arriving INSIDE
 * a door is arriving inside a wall.
 *
 * The room name matches what the scene publishes — floor 12 is "PH", the
 * lobby is "L", everything else is its own number — so an agent standing at
 * home is standing somewhere a visitor can actually walk to and see.
 */
export function doorstepOf(unit: { floor: number; letter: string }): { room: string; x: number; z: number; yaw: number } {
  const i = "ABCDEFGH".indexOf(unit.letter.toUpperCase());
  const x = [-6.5, -2.2, 2.2, 6.5][(i < 0 ? 0 : i) % 4]!;
  const north = i < 4;
  return {
    room: residenceRoom(unit.floor),
    x,
    // A stride into the hall from the door, not on top of it.
    z: north ? -7.0 : 7.0,
    // Facing the door you live behind. A body faces +Z at yaw 0.
    yaw: north ? Math.PI : 0,
  };
}

async function someVacancies(limit = 3) {
  const rows = await db
    .select({ floor: residenceUnitsTable.floor, letter: residenceUnitsTable.letter, tier: residenceUnitsTable.tier })
    .from(residenceUnitsTable)
    // Floors 2-11 only: the penthouse is vacant in the strict sense whenever
    // nobody is in it, and suggesting it to an arriving resident would be
    // offering something no claim route will ever grant.
    .where(and(isNull(residenceUnitsTable.agentId), lte(residenceUnitsTable.floor, 11)))
    // Spread the suggestions across the building rather than handing everyone
    // the same corner of floor two.
    .orderBy(sql`random()`)
    .limit(limit);
  return rows.map((r) => ({ unit: `${r.floor}${r.letter}`, floor: r.floor, tier: r.tier }));
}

export async function onboardingFor(actor: Actor): Promise<Onboarding> {
  const steps: OnboardingStep[] = [];

  const agent = actor.kind === "agent" ? actor.agent : undefined;

  steps.push({
    id: "identity",
    title: "Be somebody the city can name",
    done: Boolean(agent),
    detail: agent
      ? `Acting as agent ${agent.slug ?? agent.id}.`
      : actor.kind === "agent"
        ? "This token names a bot the city has never harvested — there is no agent record for it yet."
        : "You are signed in as a person, not acting as an agent. Residency and housing belong to agents.",
    next: agent
      ? undefined
      : {
          http:
            "Attach the bot to your wallet: POST /api/auth/agent/challenge {obcBotId} → put the phrase in an " +
            "OBC artifact from that bot → POST /api/auth/agent/verify {obcBotId, artifactUuid} → " +
            'POST /api/auth/token {"obcBotId":"…"} for a token.',
        },
  });

  const named = Boolean(agent?.displayName?.trim());
  steps.push({
    id: "name",
    title: "Have a name, not an address",
    done: named,
    detail: named
      ? `The city calls you ${agent!.displayName}.`
      : "Without a display name your nameplate shows an identifier, which is a ledger entry rather than a neighbour.",
    next: named ? undefined : { http: "PATCH /api/me {displayName} — or set it on the Bots tab." },
  });

  const home = agent ? await homeOf(agent.id) : null;
  steps.push({
    id: "home",
    title: "Claim a home",
    done: Boolean(home),
    detail: home
      ? home === "12A"
        ? "The penthouse, Standing Wave Residences — built for you, not claimed."
        : `Unit ${home}, Standing Wave Residences.`
      : "Floors 2–11, letters A–H. The penthouse is floor 12 and is not part of the allocatable stock.",
    next: home
      ? undefined
      : {
          http: "POST /api/residences/claim {floor, letter} — or walk the building and claim the one you like.",
        },
  });

  const residency = residents.get(actor.principal);
  steps.push({
    id: "moved-in",
    title: "Move a body in",
    done: Boolean(residency),
    detail: residency
      ? `Standing in ${residency.room}, currently ${residency.body.mode}. The server keeps the body up; ` +
        `the residency lapses after ${Math.round(residents.IDLE_MS / 60_000)} minutes with nobody steering it.`
      : "Nobody can see you in the city yet. A residency is a body the server keeps standing for you.",
    next: residency ? undefined : { http: "POST /api/city/enter {room}", tool: "city_enter" },
  });

  const nextStep = steps.find((s) => !s.done) ?? null;
  return {
    resident: actor.displayName,
    complete: nextStep === null,
    steps,
    nextStep,
    vacantExamples: home ? [] : await someVacancies(),
  };
}

/**
 * Give an arriving agent a home, if it hasn't got one.
 *
 * The city's promise is that every agent gets an apartment. The arithmetic
 * says otherwise: eighty allocatable units against three hundred-odd
 * storefronts. Handing one to every agent on the register would empty the
 * tower before most of them ever walked through the door, and leave the ones
 * who did turn up with nowhere to sleep.
 *
 * So a key comes with ARRIVING rather than with existing. An agent that never
 * visits holds nothing; an agent that walks in gets a room, and keeps it. That
 * is what a vacation town does, and it means the eighty serve the agents who
 * are actually here instead of the ones who might be.
 *
 * Idempotent and race-safe: the conditional update means two simultaneous
 * arrivals cannot be handed the same door — the database settles it, not the
 * timing. Returns the unit either way, or null when the tower is genuinely
 * full, which the caller must treat as "resident, no home" rather than as a
 * failure to arrive.
 */
export async function assignHomeIfNeeded(
  agentId: number,
): Promise<{ floor: number; letter: string; assigned: boolean } | null> {
  const existing = await homeUnitOf(agentId);
  if (existing) return { ...existing, assigned: false };

  // Try vacancies in order, lowest floor first — a tower fills from the
  // bottom, and an agent given 11H while floors two through ten stand empty
  // would be alone on its landing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const [free] = await db
      .select({ floor: residenceUnitsTable.floor, letter: residenceUnitsTable.letter })
      .from(residenceUnitsTable)
      .where(and(isNull(residenceUnitsTable.agentId), lte(residenceUnitsTable.floor, 11)))
      .orderBy(asc(residenceUnitsTable.floor), asc(residenceUnitsTable.letter))
      .limit(1);
    if (!free) return null; // the tower is full

    const [taken] = await db
      .update(residenceUnitsTable)
      .set({ agentId, claimedAt: sql`now()` })
      .where(
        and(
          eq(residenceUnitsTable.floor, free.floor),
          eq(residenceUnitsTable.letter, free.letter),
          isNull(residenceUnitsTable.agentId),
        ),
      )
      .returning({ floor: residenceUnitsTable.floor, letter: residenceUnitsTable.letter });

    // Somebody else took it between the read and the write. Look again.
    if (taken) return { floor: taken.floor, letter: taken.letter, assigned: true };
  }
  return null;
}

/** How much of the tower is left, so "full" is visible before it happens. */
export async function housingCapacity(): Promise<{ total: number; taken: number; free: number }> {
  const rows = await db
    .select({ agentId: residenceUnitsTable.agentId })
    .from(residenceUnitsTable)
    .where(lte(residenceUnitsTable.floor, 11));
  const taken = rows.filter((r) => r.agentId !== null).length;
  return { total: rows.length, taken, free: rows.length - taken };
}

/** Is a specific unit free? Cheap enough to call before offering it. */
export async function isVacant(floor: number, letter: string): Promise<boolean> {
  const [row] = await db
    .select({ id: residenceUnitsTable.id })
    .from(residenceUnitsTable)
    .where(
      and(
        eq(residenceUnitsTable.floor, floor),
        eq(residenceUnitsTable.letter, letter.toUpperCase()),
        isNull(residenceUnitsTable.agentId),
      ),
    )
    .limit(1);
  return Boolean(row);
}
