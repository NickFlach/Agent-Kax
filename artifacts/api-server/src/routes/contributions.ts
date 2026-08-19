import { Router, type IRouter } from "express";
import { z } from "zod";
import { resolveActor, ActorError } from "../lib/actor";
import {
  CreditError,
  creditedContributions,
  deniedForReview,
  recordMergedPr,
  respondToClaim,
} from "../lib/contributionCredit";
import { requireAdminOrServiceToken } from "../middlewares/requireAuth";

const router: IRouter = Router();

/**
 * The credit handshake's HTTP surface (#355).
 *
 * POST /contributions/record   — the merge recorder (admin or service token):
 *                                lands the trailer CLAIM, credits nothing.
 * POST /contributions/respond  — the agent's own side: confirm or deny the
 *                                (repo, pr) pair through its authenticated
 *                                session. The slug comes from the SESSION,
 *                                never the body.
 * GET  /contributions/agent/:slug        — what a slug actually earned.
 * GET  /contributions/review-queue       — denials awaiting a human.
 */

const RecordBody = z.object({
  repo: z.string().min(3).max(140),
  prNumber: z.number().int().positive(),
  slug: z.string().min(2).max(64),
});

router.post("/contributions/record", requireAdminOrServiceToken, async (req, res) => {
  const parsed = RecordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "bad request" });
    return;
  }
  try {
    const row = await recordMergedPr({ ...parsed.data, recordedBy: "service:contribution-recorder" });
    res.json({ id: row.id, status: row.status, reason: row.reason });
  } catch (e) {
    if (e instanceof CreditError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

const RespondBody = z.object({
  repo: z.string().min(3).max(140),
  prNumber: z.number().int().positive(),
  /** true = "this was me"; false = "this was NOT me". */
  claim: z.boolean(),
});

router.post("/contributions/respond", async (req, res) => {
  const parsed = RespondBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "bad request" });
    return;
  }
  try {
    const actor = await resolveActor(req);
    if (!actor) {
      res.status(401).json({ error: "an authenticated agent session is required" });
      return;
    }
    const row = await respondToClaim({ ...parsed.data, actor, claim: parsed.data.claim });
    res.json({
      id: row.id,
      status: row.status,
      slug: row.slug,
      confirmedPrincipal: row.confirmedPrincipal,
      confirmedBotId: row.confirmedBotId,
    });
  } catch (e) {
    if (e instanceof ActorError || e instanceof CreditError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.get("/contributions/agent/:slug", async (req, res) => {
  const rows = await creditedContributions(String(req.params["slug"] ?? ""));
  res.json({
    slug: String(req.params["slug"] ?? "").toLowerCase(),
    credited: rows.map((r) => ({
      repo: r.repo,
      prNumber: r.prNumber,
      confirmedPrincipal: r.confirmedPrincipal,
      confirmedBotId: r.confirmedBotId,
      confirmedAt: r.confirmedAt,
    })),
  });
});

router.get("/contributions/review-queue", async (_req, res) => {
  const rows = await deniedForReview();
  res.json({
    denied: rows.map((r) => ({
      repo: r.repo,
      prNumber: r.prNumber,
      slug: r.slug,
      deniedBy: r.confirmedPrincipal,
      deniedAt: r.confirmedAt,
      reason: r.reason,
    })),
  });
});

export default router;
