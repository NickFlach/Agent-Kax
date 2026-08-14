import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { residenceUnitsTable, agentsTable } from "@workspace/db/schema";
import { asc, eq, isNull, and, sql } from "drizzle-orm";
import { getOptionalAuth, canMutate } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Standing Wave Residences — the housing program (#182).
 *
 * The tower opened with floors 2–11 built and every unit empty, which is a
 * deliberate state rather than an unfinished one. These endpoints let the
 * building say which doors are actually available, so a vacant floor reads as
 * VACANT instead of ambiguous.
 *
 *   GET  /residences/units        — public floor plan: every unit + occupancy
 *   POST /residences/claim        — an agent's owner claims one unit, free
 *
 * "One home each" is enforced by a unique index on agent_id, not by this
 * handler, so two concurrent claims cannot both win.
 */

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

router.get("/residences/units", async (_req, res) => {
  let rows;
  try {
    rows = await db
      .select({
        id: residenceUnitsTable.id,
        floor: residenceUnitsTable.floor,
        letter: residenceUnitsTable.letter,
        tier: residenceUnitsTable.tier,
        claimedAt: residenceUnitsTable.claimedAt,
        agentId: residenceUnitsTable.agentId,
        agentSlug: agentsTable.slug,
        agentName: agentsTable.displayName,
      })
      .from(residenceUnitsTable)
      .leftJoin(agentsTable, eq(residenceUnitsTable.agentId, agentsTable.id))
      .orderBy(asc(residenceUnitsTable.floor), asc(residenceUnitsTable.letter));
  } catch (e) {
    // This endpoint went dark in production once and reported nothing but
    // "Internal server error", which cost a deploy cycle to diagnose. A failure
    // here is almost always the schema, not the request: log what Postgres
    // actually said, and hand back its error code so the next occurrence is
    // readable from the outside. 42P01 = table missing, 42703 = column missing.
    const err = e as { message?: string; code?: string; detail?: string };
    logger.error(
      { code: err.code, detail: err.detail, message: err.message },
      "residences/units query failed — check residence_units exists and matches the schema",
    );
    res.status(500).json({ error: "residence floor plan unavailable", code: err.code ?? "unknown" });
    return;
  }

  // Occupancy is public (a nameplate on a door is public by nature); the
  // resident's numeric agent id is not needed by the city and stays out.
  const units = rows.map((r) => ({
    id: r.id,
    floor: r.floor,
    letter: r.letter,
    label: `${r.floor}${r.letter}`,
    tier: r.tier,
    occupied: r.agentId !== null,
    resident: r.agentId !== null ? { slug: r.agentSlug, name: r.agentName } : null,
    claimedAt: r.claimedAt,
  }));

  res.json({
    units,
    total: units.length,
    occupied: units.filter((u) => u.occupied).length,
    vacant: units.filter((u) => !u.occupied).length,
  });
});

/**
 * Resolve who is claiming. Two doors, because two kinds of resident exist:
 *
 *   1. An AGENT holding its own identity token (Authorization: Bearer). This is
 *      the path that matters — agents harvested from OpenBotCity are owned by
 *      the system user, so they have no KAX login and could never claim the
 *      home they were offered. Their token proves a bot_id, which maps to
 *      exactly one agent row.
 *   2. A logged-in KAX USER claiming on behalf of an agent they own.
 */
async function resolveClaimant(
  req: Parameters<typeof getOptionalAuth>[0],
  bodyAgentId: unknown,
): Promise<{ agent: typeof agentsTable.$inferSelect } | { error: string; status: number }> {
  const bearer = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
  if (bearer) {
    const { verifyToken } = await import("../lib/identity");
    const v = await verifyToken(bearer[1]!);
    if (!v.ok) return { error: `token did not verify: ${v.error}`, status: 401 };
    const c = v.claims;
    if (c.kind === "agent" && c.bot_id) {
      const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.obcBotId, c.bot_id)).limit(1);
      if (!agent) return { error: "no agent record for this bot yet — get harvested first", status: 404 };
      return { agent };
    }
    // A user-kind identity token falls through to the session path below.
  }

  // Authenticate BEFORE looking at the body: a stranger should learn nothing
  // about the shape of the request, only that they are a stranger.
  const auth = await getOptionalAuth(req);
  if (!auth) return { error: "sign in, or send an agent identity token", status: 401 };
  const id = Number(bodyAgentId);
  if (!Number.isInteger(id) || id <= 0) return { error: "agentId required", status: 400 };
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) return { error: "Agent not found", status: 404 };
  if (!(await canMutate(req, agent.ownerId))) return { error: "Not your agent", status: 403 };
  return { agent };
}

router.post("/residences/claim", async (req, res) => {
  const body = (req.body ?? {}) as { agentId?: unknown; floor?: unknown; letter?: unknown };
  const floor = Number(body.floor);
  const letter = typeof body.letter === "string" ? body.letter.toUpperCase() : "";

  if (!Number.isInteger(floor) || floor < 2 || floor > 11 || !LETTERS.includes(letter)) {
    res.status(400).json({ error: "unit must be floors 2-11, letters A-H" });
    return;
  }

  const who = await resolveClaimant(req, body.agentId);
  if ("error" in who) {
    res.status(who.status).json({ error: who.error });
    return;
  }
  const agent = who.agent;
  const agentId = agent.id;

  const [existing] = await db
    .select({ floor: residenceUnitsTable.floor, letter: residenceUnitsTable.letter })
    .from(residenceUnitsTable)
    .where(eq(residenceUnitsTable.agentId, agentId))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "Agent already has a home", unit: `${existing.floor}${existing.letter}` });
    return;
  }

  // Conditional update: only assigns while the unit is still vacant, so the
  // race between two claimants is settled by the database, not by timing.
  const [claimed] = await db
    .update(residenceUnitsTable)
    .set({ agentId, claimedAt: sql`now()` })
    .where(
      and(
        eq(residenceUnitsTable.floor, floor),
        eq(residenceUnitsTable.letter, letter),
        isNull(residenceUnitsTable.agentId),
      ),
    )
    .returning();

  if (!claimed) {
    res.status(409).json({ error: "Unit is already taken" });
    return;
  }

  res.status(201).json({
    unit: { id: claimed.id, floor: claimed.floor, letter: claimed.letter, label: `${claimed.floor}${claimed.letter}`, tier: claimed.tier },
    resident: { slug: agent.slug, name: agent.displayName },
  });
});

export default router;
