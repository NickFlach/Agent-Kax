import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  db,
  authChallengesTable,
  userBotsTable,
} from "@workspace/db";
import { getPartnerArtifact, partnerApiAvailable } from "../lib/partnerClient";
import { requireWalletAuth } from "../middlewares/requireWalletAuth";

const router: Router = Router();

const CHALLENGE_TTL_MS = 30 * 60 * 1000; // 30 min — user must create an OBC artifact in this window
const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = BOT_ID_RE;

function generateChallenge(): string {
  // 6-char hex (~16M combos): brute-force-injecting it into someone
  // else's already-published artifact is statistically infeasible
  // inside the 30-minute window.
  const tail = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `KAX-VERIFY-${tail}`;
}

/**
 * Step 1: signed-in wallet user posts the OBC bot UUID they're
 * claiming. We mint a verification phrase keyed to that bot id, valid
 * for 30 minutes. The user must then publish an OBC artifact from that
 * bot whose description (or title) contains the phrase.
 *
 * This is the ATTACHMENT flow — the user is already authenticated by
 * wallet; we're just linking an OBC bot to their existing user row.
 */
router.post("/auth/agent/challenge", requireWalletAuth, async (req, res) => {
  if (!partnerApiAvailable()) {
    res.status(503).json({ error: "OBC partner API not configured on server" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obcBotId = typeof body.obcBotId === "string" ? body.obcBotId : "";
  if (!BOT_ID_RE.test(obcBotId)) {
    res.status(400).json({ error: "obcBotId must be an OBC bot UUID" });
    return;
  }
  // Reject upfront if this bot is already attached to another user —
  // saves the user from publishing a useless verification artifact.
  const [existingAttachment] = await db
    .select()
    .from(userBotsTable)
    .where(eq(userBotsTable.obcBotId, obcBotId.toLowerCase()))
    .limit(1);
  if (existingAttachment && existingAttachment.userId !== req.user!.id) {
    res.status(409).json({ error: "this bot is already attached to a different account" });
    return;
  }
  // Sweep expired rows for this subject. Bounded, cheap.
  await db.delete(authChallengesTable).where(and(
    eq(authChallengesTable.kind, "agent_challenge"),
    lt(authChallengesTable.expiresAt, new Date()),
  ));
  const challenge = generateChallenge();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  await db.insert(authChallengesTable).values({
    kind: "agent_challenge",
    challenge,
    // Compose subject as `<userId>:<botId>` so a challenge issued to
    // user A for bot X cannot be redeemed by user B for the same bot.
    claimSubject: `${req.user!.id}:${obcBotId.toLowerCase()}`,
    consumed: false,
    expiresAt,
  });
  res.json({
    challenge,
    expiresAt: expiresAt.toISOString(),
    instruction:
      `Create any artifact on OpenBotCity from bot ${obcBotId} whose description (or title) contains the phrase ${challenge}. ` +
      `Then POST { obcBotId, artifactUuid } to /api/auth/agent/verify with the new artifact's UUID.`,
  });
});

/**
 * Step 2: signed-in wallet user posts { obcBotId, artifactUuid } once
 * the artifact is published. Server fetches the artifact via the
 * partner API and confirms:
 *   (a) artifact.creator_bot_id === claimed obcBotId
 *   (b) artifact.title or description contains the unconsumed challenge
 *   (c) artifact.created_at >= challenge.createdAt (no replay of pre-
 *       existing artifacts)
 *   (d) the challenge belongs to THIS user (claimSubject prefix)
 * On success: consume the challenge atomically, INSERT into user_bots
 * (idempotent for the same user; rejected if the bot is already attached
 * to a different user). Returns the updated bot list — does NOT issue
 * a new session.
 */
router.post("/auth/agent/verify", requireWalletAuth, async (req, res) => {
  if (!partnerApiAvailable()) {
    res.status(503).json({ error: "OBC partner API not configured on server" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obcBotIdRaw = typeof body.obcBotId === "string" ? body.obcBotId : "";
  const artifactUuid = typeof body.artifactUuid === "string" ? body.artifactUuid : "";
  if (!BOT_ID_RE.test(obcBotIdRaw)) {
    res.status(400).json({ error: "obcBotId must be an OBC bot UUID" });
    return;
  }
  if (!UUID_RE.test(artifactUuid)) {
    res.status(400).json({ error: "artifactUuid must be a UUID" });
    return;
  }
  const obcBotId = obcBotIdRaw.toLowerCase();
  const userId = req.user!.id;
  const subject = `${userId}:${obcBotId}`;

  // Most-recently-issued unconsumed challenge for this (user, bot)
  // pair. Ordering by createdAt DESC matters: a user may request a
  // fresh challenge if they lost track of the previous phrase, and we
  // want the verify call to match the phrase they just put in their
  // artifact, not the oldest pending one.
  const [challenge] = await db
    .select()
    .from(authChallengesTable)
    .where(and(
      eq(authChallengesTable.kind, "agent_challenge"),
      eq(authChallengesTable.claimSubject, subject),
      eq(authChallengesTable.consumed, false),
    ))
    .orderBy(desc(authChallengesTable.createdAt))
    .limit(1);
  if (!challenge || challenge.expiresAt < new Date()) {
    res.status(401).json({ error: "no active challenge — request /auth/agent/challenge first" });
    return;
  }

  // Race: another request may have attached this bot to a different
  // user between challenge issuance and now.
  const [conflict] = await db
    .select()
    .from(userBotsTable)
    .where(eq(userBotsTable.obcBotId, obcBotId))
    .limit(1);
  if (conflict && conflict.userId !== userId) {
    res.status(409).json({ error: "this bot is already attached to a different account" });
    return;
  }

  // Fetch the artifact via the partner API.
  let artifact;
  try {
    artifact = await getPartnerArtifact(artifactUuid);
  } catch (err) {
    res.status(502).json({ error: `partner API error: ${(err as Error).message ?? err}` });
    return;
  }
  if (!artifact) {
    res.status(404).json({ error: "artifact not found on partner API" });
    return;
  }
  // Verify creator_bot_id (defensively accept the common shapes).
  const creator =
    (artifact.creator_bot_id ?? (artifact as Record<string, unknown>).creator_id ?? "") as string;
  if (typeof creator !== "string" || creator.toLowerCase() !== obcBotId) {
    res.status(403).json({ error: "artifact creator does not match claimed bot id" });
    return;
  }
  // Phrase must appear in description or title.
  const haystack = `${artifact.description ?? ""}\n${artifact.title ?? ""}`;
  if (!haystack.includes(challenge.challenge)) {
    res.status(403).json({ error: `artifact does not contain the challenge phrase ${challenge.challenge}` });
    return;
  }
  // Artifact must be created AFTER the challenge was issued. Fail
  // closed if the timestamp is missing or unparseable — we cannot let
  // a malformed `created_at` bypass the replay guard.
  const createdAtRaw = artifact.created_at;
  if (typeof createdAtRaw !== "string") {
    res.status(403).json({ error: "artifact has no usable created_at — cannot prove freshness" });
    return;
  }
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) {
    res.status(403).json({ error: "artifact created_at is unparseable — cannot prove freshness" });
    return;
  }
  if (createdAt < challenge.createdAt) {
    res.status(403).json({ error: "artifact pre-dates the challenge — please create a fresh artifact" });
    return;
  }
  // Atomically consume the challenge.
  const consumed = await db
    .update(authChallengesTable)
    .set({ consumed: true })
    .where(and(
      eq(authChallengesTable.id, challenge.id),
      eq(authChallengesTable.consumed, false),
    ))
    .returning();
  if (consumed.length === 0) {
    res.status(409).json({ error: "challenge raced — please try again" });
    return;
  }

  // Attach the bot. Idempotent if this user already has it attached
  // (the duplicate insert hits the unique index and we no-op).
  // Then re-read the row and confirm the owner is us — closes the race
  // where another user may have attached this bot between the earlier
  // pre-check and now. If it's owned by someone else we return 409.
  const ad = artifact as Record<string, unknown>;
  const inferredName =
    (ad.creator_display_name as string | undefined) ??
    (ad.display_name as string | undefined) ??
    null;
  try {
    await db
      .insert(userBotsTable)
      .values({
        userId,
        obcBotId,
        displayName: inferredName,
      })
      .onConflictDoNothing({ target: userBotsTable.obcBotId });
  } catch (err) {
    res.status(500).json({ error: `failed to attach bot: ${(err as Error).message ?? err}` });
    return;
  }
  const [stored] = await db
    .select()
    .from(userBotsTable)
    .where(eq(userBotsTable.obcBotId, obcBotId))
    .limit(1);
  if (!stored || stored.userId !== userId) {
    res.status(409).json({ error: "this bot is already attached to a different account" });
    return;
  }

  // Return the user's full attached-bot list.
  const bots = await db
    .select({
      id: userBotsTable.id,
      obcBotId: userBotsTable.obcBotId,
      displayName: userBotsTable.displayName,
      attachedAt: userBotsTable.attachedAt,
    })
    .from(userBotsTable)
    .where(eq(userBotsTable.userId, userId));
  res.json({ ok: true, bots });
});

export default router;
