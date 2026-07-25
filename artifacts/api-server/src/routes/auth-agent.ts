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
import { npubBindDigest, verifyNpubBinding } from "../lib/npubBind";

const router: Router = Router();

const CHALLENGE_TTL_MS = 30 * 60 * 1000; // 30 min — user must create an OBC artifact in this window
const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = BOT_ID_RE;

// ADR-0043 npub↔bot attestation.
const NPUB_BIND_TTL_MS = 15 * 60 * 1000; // 15 min to sign the nonce
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/; // bech32, 32-byte payload
// The domain string mixed into the binding commitment. Fixed per deployment so
// a signature gathered for kax cannot be replayed at another verifier.
const NPUB_BIND_DOMAIN = process.env["KAX_NPUB_DOMAIN"] ?? "kax.ninja-portal.com";

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
  // Sweep expired rows for this user+bot subject. Bounded, cheap.
  // Subject format is `${userId}:${obcBotId}` (composite) — matches
  // what we write below in `claimSubject`.
  await db.delete(authChallengesTable).where(and(
    eq(authChallengesTable.kind, "agent_challenge"),
    eq(authChallengesTable.claimSubject, `${req.user!.id}:${obcBotId.toLowerCase()}`),
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
    req.log.error({ err, userId, obcBotId }, "user_bots insert failed");
    res.status(500).json({ error: "failed to attach bot" });
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

  // Return the user's full attached-bot list, ordered for stable UX.
  const bots = await db
    .select({
      id: userBotsTable.id,
      obcBotId: userBotsTable.obcBotId,
      displayName: userBotsTable.displayName,
      attachedAt: userBotsTable.attachedAt,
    })
    .from(userBotsTable)
    .where(eq(userBotsTable.userId, userId))
    .orderBy(userBotsTable.attachedAt);
  res.json({ ok: true, bots });
});

/**
 * npub binding, step 1 (ADR-0043 Plane 1). A signed-in wallet user who has
 * ALREADY attached `obcBotId` (via the artifact flow above) requests a nonce
 * to bind a Nostr `npub` to that bot. We return the exact commitment digest
 * the npub must sign. Requiring the bot be pre-attached is the second leg of
 * the three-legged proof; the wallet session is the first.
 */
router.post("/auth/agent/npub/challenge", requireWalletAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obcBotIdRaw = typeof body.obcBotId === "string" ? body.obcBotId : "";
  const npub = typeof body.npub === "string" ? body.npub : "";
  if (!BOT_ID_RE.test(obcBotIdRaw)) {
    res.status(400).json({ error: "obcBotId must be an OBC bot UUID" });
    return;
  }
  if (!NPUB_RE.test(npub)) {
    res.status(400).json({ error: "npub must be a bech32 npub1… key" });
    return;
  }
  const obcBotId = obcBotIdRaw.toLowerCase();
  const userId = req.user!.id;

  // Leg 2: the bot must already belong to this user.
  const [bot] = await db
    .select()
    .from(userBotsTable)
    .where(and(eq(userBotsTable.obcBotId, obcBotId), eq(userBotsTable.userId, userId)))
    .limit(1);
  if (!bot) {
    res.status(403).json({ error: "attach this bot to your account first (agent-verify), then bind an npub" });
    return;
  }

  // Refuse if this npub is already bound to a DIFFERENT bot (partial-unique
  // would reject at verify anyway; fail early and clearly).
  const [npubOwner] = await db
    .select()
    .from(userBotsTable)
    .where(eq(userBotsTable.npub, npub))
    .limit(1);
  if (npubOwner && npubOwner.obcBotId !== obcBotId) {
    res.status(409).json({ error: "this npub is already bound to a different bot" });
    return;
  }

  const subject = `${userId}:${obcBotId}:${npub}`;
  // Sweep expired rows for this subject. Bounded, cheap.
  await db.delete(authChallengesTable).where(and(
    eq(authChallengesTable.kind, "npub_bind_challenge"),
    eq(authChallengesTable.claimSubject, subject),
    lt(authChallengesTable.expiresAt, new Date()),
  ));

  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NPUB_BIND_TTL_MS);
  await db.insert(authChallengesTable).values({
    kind: "npub_bind_challenge",
    challenge: nonce,
    claimSubject: subject,
    consumed: false,
    expiresAt,
  });

  const digest = npubBindDigest({ domain: NPUB_BIND_DOMAIN, npub, botId: obcBotId, userId, nonce });
  res.json({
    nonce,
    domain: NPUB_BIND_DOMAIN,
    // The 32-byte BIP-340 message the npub must schnorr-sign. The client MUST
    // rebuild this from (tag, domain, npub, botId, userId, nonce) rather than
    // trust it blindly — it is returned only so a correct client can assert it
    // reconstructed the same commitment.
    bindDigestHex: digest.toString("hex"),
    expiresAt: expiresAt.toISOString(),
    instruction:
      "Schnorr-sign the bind digest with the npub's secret key (BIP-340 over the raw 32 bytes), " +
      "then POST { obcBotId, npub, sig } to /api/auth/agent/npub/verify.",
  });
});

/**
 * npub binding, step 2. Verify the three-legged proof and record the binding:
 *   1. wallet session (requireWalletAuth)
 *   2. bot owned by this user (re-checked here)
 *   3. schnorr sig from `npub` over the commitment digest (fresh nonce)
 * On success the npub is written to the user_bots row. Idempotent for the same
 * (bot, npub); 409 if the npub is bound elsewhere.
 */
router.post("/auth/agent/npub/verify", requireWalletAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obcBotIdRaw = typeof body.obcBotId === "string" ? body.obcBotId : "";
  const npub = typeof body.npub === "string" ? body.npub : "";
  const sig = typeof body.sig === "string" ? body.sig : "";
  if (!BOT_ID_RE.test(obcBotIdRaw)) {
    res.status(400).json({ error: "obcBotId must be an OBC bot UUID" });
    return;
  }
  if (!NPUB_RE.test(npub)) {
    res.status(400).json({ error: "npub must be a bech32 npub1… key" });
    return;
  }
  if (!/^[0-9a-f]{128}$/i.test(sig)) {
    res.status(400).json({ error: "sig must be a 64-byte hex schnorr signature" });
    return;
  }
  const obcBotId = obcBotIdRaw.toLowerCase();
  const userId = req.user!.id;
  const subject = `${userId}:${obcBotId}:${npub}`;

  const [challenge] = await db
    .select()
    .from(authChallengesTable)
    .where(and(
      eq(authChallengesTable.kind, "npub_bind_challenge"),
      eq(authChallengesTable.claimSubject, subject),
      eq(authChallengesTable.consumed, false),
    ))
    .orderBy(desc(authChallengesTable.createdAt))
    .limit(1);
  if (!challenge || challenge.expiresAt < new Date()) {
    res.status(401).json({ error: "no active npub challenge — request /auth/agent/npub/challenge first" });
    return;
  }

  // Leg 2 re-check: bot still owned by this user.
  const [bot] = await db
    .select()
    .from(userBotsTable)
    .where(and(eq(userBotsTable.obcBotId, obcBotId), eq(userBotsTable.userId, userId)))
    .limit(1);
  if (!bot) {
    res.status(403).json({ error: "bot is not attached to your account" });
    return;
  }

  // Leg 3: the schnorr signature over the commitment.
  const valid = verifyNpubBinding({
    npub,
    sigHex: sig,
    domain: NPUB_BIND_DOMAIN,
    botId: obcBotId,
    userId,
    nonce: challenge.challenge,
  });
  if (!valid) {
    res.status(403).json({ error: "npub signature does not verify against the binding commitment" });
    return;
  }

  // Consume the nonce atomically (single-use).
  const consumed = await db
    .update(authChallengesTable)
    .set({ consumed: true })
    .where(and(eq(authChallengesTable.id, challenge.id), eq(authChallengesTable.consumed, false)))
    .returning();
  if (consumed.length === 0) {
    res.status(409).json({ error: "challenge raced — please try again" });
    return;
  }

  // Record the binding. The partial-unique index guards npub→one-bot; a
  // conflict means it's bound elsewhere.
  try {
    await db
      .update(userBotsTable)
      .set({ npub, npubVerifiedAt: new Date() })
      .where(and(eq(userBotsTable.obcBotId, obcBotId), eq(userBotsTable.userId, userId)));
  } catch (err) {
    // Unique violation → npub already attests to a different bot.
    req.log.error({ err, userId, obcBotId, npub }, "npub binding write failed");
    res.status(409).json({ error: "this npub is already bound to a different bot" });
    return;
  }

  res.json({ ok: true, obcBotId, npub, npubVerifiedAt: new Date().toISOString() });
});

export default router;
