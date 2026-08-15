import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { residenceUnitsTable, agentsTable } from "@workspace/db/schema";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { resolveActor, agentForActor, ActorError } from "../lib/actor";
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
      // The floor plan is the ALLOCATABLE stock. The penthouse is a real row
      // now, but it is not a unit anybody can be shown as available, and
      // folding it in here would quietly change every count that reads this —
      // "80 units" is load-bearing in the concierge's dialogue and the smoke
      // test alike. It comes back separately below.
      .where(lte(residenceUnitsTable.floor, 11))
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

  // The penthouse, alongside rather than among. It is a real address with a
  // real resident, but it is not stock — counting it in `total` would make
  // "80 units" wrong everywhere that reads this, and listing it among the
  // units would offer somebody a home no claim route will ever grant.
  let penthouse: { label: string; floor: number; tier: number; resident: { slug: string | null; name: string | null } | null } | null = null;
  try {
    const [ph] = await db
      .select({
        floor: residenceUnitsTable.floor,
        letter: residenceUnitsTable.letter,
        tier: residenceUnitsTable.tier,
        agentId: residenceUnitsTable.agentId,
        agentSlug: agentsTable.slug,
        agentName: agentsTable.displayName,
      })
      .from(residenceUnitsTable)
      .leftJoin(agentsTable, eq(residenceUnitsTable.agentId, agentsTable.id))
      .where(eq(residenceUnitsTable.floor, 12))
      .limit(1);
    if (ph) {
      penthouse = {
        label: `${ph.floor}${ph.letter}`,
        floor: ph.floor,
        tier: ph.tier,
        resident: ph.agentId !== null ? { slug: ph.agentSlug, name: ph.agentName } : null,
      };
    }
  } catch {
    // The floor plan is the point of this endpoint; a missing penthouse row is
    // not worth failing it over.
  }

  res.json({
    units,
    total: units.length,
    occupied: units.filter((u) => u.occupied).length,
    vacant: units.filter((u) => !u.occupied).length,
    penthouse,
  });
});

router.post("/residences/claim", async (req, res) => {
  const body = (req.body ?? {}) as { agentId?: unknown; floor?: unknown; letter?: unknown };
  const floor = Number(body.floor);
  const letter = typeof body.letter === "string" ? body.letter.toUpperCase() : "";

  if (!Number.isInteger(floor) || floor < 2 || floor > 11 || !LETTERS.includes(letter)) {
    res.status(400).json({ error: "unit must be floors 2-11, letters A-H" });
    return;
  }

  let agent;
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      res.status(401).json({ error: "sign in, or send an agent identity token" });
      return;
    }
    agent = await agentForActor(actor, req, body.agentId);
  } catch (e) {
    if (e instanceof ActorError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
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
