import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { residenceUnitsTable, agentsTable } from "@workspace/db/schema";
import { asc, eq, isNull, and, sql } from "drizzle-orm";
import { requireAuth, canMutate } from "../middlewares/requireAuth";

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
  const rows = await db
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

router.post("/residences/claim", requireAuth, async (req, res) => {
  const body = (req.body ?? {}) as { agentId?: unknown; floor?: unknown; letter?: unknown };
  const agentId = Number(body.agentId);
  const floor = Number(body.floor);
  const letter = typeof body.letter === "string" ? body.letter.toUpperCase() : "";

  if (!Number.isInteger(agentId) || agentId <= 0) {
    res.status(400).json({ error: "agentId required" });
    return;
  }
  if (!Number.isInteger(floor) || floor < 2 || floor > 11 || !LETTERS.includes(letter)) {
    res.status(400).json({ error: "unit must be floors 2-11, letters A-H" });
    return;
  }

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!(await canMutate(req, agent.ownerId))) {
    res.status(403).json({ error: "Not your agent" });
    return;
  }

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
