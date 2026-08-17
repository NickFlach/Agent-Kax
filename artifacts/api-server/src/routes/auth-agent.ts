import { Router } from "express";
import { detectNonPublic } from "../lib/artifactPublication";
import { composeAnnouncement, findNoncePost, linkNonce, HANDLE_RE as bskyHandleRe, BlueskyError } from "../lib/bluesky";
import crypto from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  db,
  authChallengesTable,
  userBotsTable,
} from "@workspace/db";
import {
  getPartnerArtifact,
  partnerApiAvailable,
  creatorBotIdOf,
  creatorDisplayNameOf,
} from "../lib/partnerClient";
import { requireWalletAuth } from "../middlewares/requireWalletAuth";
import { requireAttachAuth, sessionStrength, mayChangeBot } from "../middlewares/botAttachAuth";
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
router.post("/auth/agent/challenge", requireAttachAuth, async (req, res) => {
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
router.post("/auth/agent/verify", requireAttachAuth, async (req, res) => {
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
  // Verify creator_bot_id across every shape the partner API sends, including
  // the nested `creator.id` this repo models as canonical elsewhere. Detail
  // responses come back un-normalised, so reading only the top-level keys
  // rejected legitimate ownership proofs with "creator does not match". (#81)
  const creator = creatorBotIdOf(artifact) ?? "";
  if (creator.toLowerCase() !== obcBotId) {
    res.status(403).json({ error: "artifact creator does not match claimed bot id" });
    return;
  }
  // The instructions say "publish an artifact", so an artifact that declares
  // itself private/draft/unlisted is not the proof the user was asked for —
  // nobody outside this server's partner integration could ever see it. (#115)
  //
  // Rejects only on a POSITIVE non-public signal. An artifact carrying no
  // visibility information is accepted exactly as before, deliberately: see
  // lib/artifactPublication.ts for why requiring proof-of-publication would be
  // the more dangerous choice.
  const publication = detectNonPublic(artifact);
  if (publication.nonPublic) {
    req.log.info(
      { obcBotId, signal: publication.signal },
      "agent verify rejected a non-public artifact",
    );
    res.status(403).json({
      error: `artifact is not public (${publication.signal}) — publish it so the proof is visible, then retry`,
    });
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
  // Attach the bot. Idempotent if this user already has it attached
  // (the duplicate insert hits the unique index and we no-op).
  // Then re-read the row and confirm the owner is us — closes the race
  // where another user may have attached this bot between the earlier
  // pre-check and now. If it's owned by someone else we return 409.
  // Same shape problem as the id above: a nested `creator.display_name` was
  // ignored, so an attachment could succeed while storing a null bot name,
  // which makes multi-bot management and reply routing harder to reason
  // about. (#81)
  const inferredName = creatorDisplayNameOf(artifact);
  try {
    // Record how strong this session was. Not to gate the attach — the OCC
    // proof above already did that — but so that undoing it later cannot be
    // done with less (#112).
    const attachedVia = (await sessionStrength(req)) ?? "session";
    await db
      .insert(userBotsTable)
      .values({
        userId,
        obcBotId,
        displayName: inferredName,
        attachedVia,
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

  // Consume the challenge only now that the attachment is CONFIRMED.
  //
  // This used to run before the insert, so any failure afterwards -- a DB
  // blip on the insert, or losing the owner re-read race -- burned the
  // challenge anyway. And because verification also requires
  // `artifact.created_at >= challenge.createdAt`, the user's existing OBC
  // artifact became useless: they had to request a new challenge AND publish
  // a brand new artifact for it. A transient error cost real work. (#111)
  //
  // Deferring is safe because a challenge is scoped to one (user, bot) pair.
  // Reusing it can only re-attach the same bot to the same user, and the
  // insert is onConflictDoNothing followed by an owner check -- idempotent.
  // The attachment, not the challenge row, is the thing being protected.
  await db
    .update(authChallengesTable)
    .set({ consumed: true })
    .where(and(
      eq(authChallengesTable.id, challenge.id),
      eq(authChallengesTable.consumed, false),
    ));

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
router.post("/auth/agent/npub/challenge", requireAttachAuth, async (req, res) => {
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
  // Binding another identity CHANGES an existing attachment, so it needs
  // at least the credential that made it (#112).
  if (!(await mayChangeBot(req, res, obcBotId))) return;

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
 *   1. any signed-in, non-disabled account (requireAttachAuth) — NOT a wallet.
 *      This line said "wallet session (requireWalletAuth)" long after the route
 *      below stopped doing that, and a stale comment about an auth requirement
 *      is worse than no comment: it is the thing somebody quotes as evidence
 *      that KAX still makes residents install a crypto wallet. It does not, and
 *      has not since `middlewares/botAttachAuth.ts` started RECORDING session
 *      strength (`user_bots.attached_via`) instead of demanding it — a weaker
 *      credential still cannot undo a stronger attestation (#112 stays fixed),
 *      but somebody who verified their bot through OpenClawCity gets their
 *      store without a wallet. The wallet is for collectors, not for residents.
 *   2. bot owned by this user (re-checked here)
 *   3. schnorr sig from `npub` over the commitment digest (fresh nonce)
 * On success the npub is written to the user_bots row. Idempotent for the same
 * (bot, npub); 409 if the npub is bound elsewhere.
 */
router.post("/auth/agent/npub/verify", requireAttachAuth, async (req, res) => {
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
  // Binding another identity CHANGES an existing attachment, so it needs
  // at least the credential that made it (#112).
  if (!(await mayChangeBot(req, res, obcBotId))) return;

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

// ── Bluesky link ───────────────────────────────────────────────────────
//
// The same shape as the OBC artifact proof, with one difference that changes
// the design: the artifact here is a PUBLIC POST. So the challenge hands back
// a composed announcement worth reading rather than a bare code — the thing
// somebody has to publish anyway becomes the thing that tells their followers
// where their agent now lives.
//
// We compose it. We never post it. A human reads it, approves it, publishes
// it. An identity flow that posts under your handle before you have seen the
// words is a bad way to begin a relationship, whatever the copy says.

const BSKY_BIND_TTL_MS = 60 * 60_000;

router.post("/auth/agent/bsky/challenge", requireAttachAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obcBotId = (typeof body.obcBotId === "string" ? body.obcBotId : "").toLowerCase();
  const handle = (typeof body.handle === "string" ? body.handle : "").trim().replace(/^@/, "").toLowerCase();

  if (!BOT_ID_RE.test(obcBotId)) {
    res.status(400).json({ error: "obcBotId must be an OBC bot UUID" });
    return;
  }
  if (!bskyHandleRe.test(handle)) {
    res.status(400).json({ error: "handle must be a Bluesky handle, e.g. yourname.bsky.social" });
    return;
  }

  // Binding another identity CHANGES an existing attachment, so it needs

  // at least the credential that made it (#112).

  if (!(await mayChangeBot(req, res, obcBotId))) return;


  const userId = req.user!.id;
  const [owned] = await db
    .select()
    .from(userBotsTable)
    .where(and(eq(userBotsTable.obcBotId, obcBotId), eq(userBotsTable.userId, userId)))
    .limit(1);
  if (!owned) {
    res.status(403).json({ error: "attach this bot to your wallet before linking anything to it" });
    return;
  }

  // Fail early and clearly rather than at verify: a handle attests to at most
  // one bot, and the partial-unique index would reject it there anyway.
  const [taken] = await db
    .select()
    .from(userBotsTable)
    .where(eq(userBotsTable.bskyHandle, handle))
    .limit(1);
  if (taken && taken.obcBotId !== obcBotId) {
    res.status(409).json({ error: "that handle is already linked to a different bot" });
    return;
  }

  const subject = `${userId}:${obcBotId}:${handle}`;
  await db.delete(authChallengesTable).where(and(
    eq(authChallengesTable.kind, "bsky_bind_challenge"),
    eq(authChallengesTable.claimSubject, subject),
    lt(authChallengesTable.expiresAt, new Date()),
  ));

  const nonce = linkNonce(crypto.randomBytes(5).toString("hex"));
  const post = composeAnnouncement({ agentName: owned.displayName || "My agent", nonce });
  await db.insert(authChallengesTable).values({
    kind: "bsky_bind_challenge",
    challenge: nonce,
    payload: post,
    claimSubject: subject,
    consumed: false,
    expiresAt: new Date(Date.now() + BSKY_BIND_TTL_MS),
  });

  res.json({
    nonce,
    handle,
    // Exactly what to publish. Read it first — nothing is posted for you.
    post,
    postLength: post.length,
    expiresInMs: BSKY_BIND_TTL_MS,
    next: "Publish this from that account, then POST /auth/agent/bsky/verify with the same obcBotId and handle.",
  });
});

router.post("/auth/agent/bsky/verify", requireAttachAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const obcBotId = (typeof body.obcBotId === "string" ? body.obcBotId : "").toLowerCase();
  const handle = (typeof body.handle === "string" ? body.handle : "").trim().replace(/^@/, "").toLowerCase();
  // Binding another identity CHANGES an existing attachment, so it needs
  // at least the credential that made it (#112).
  if (!(await mayChangeBot(req, res, obcBotId))) return;

  const userId = req.user!.id;
  const subject = `${userId}:${obcBotId}:${handle}`;

  const [challenge] = await db
    .select()
    .from(authChallengesTable)
    .where(and(
      eq(authChallengesTable.kind, "bsky_bind_challenge"),
      eq(authChallengesTable.claimSubject, subject),
      eq(authChallengesTable.consumed, false),
    ))
    .orderBy(desc(authChallengesTable.createdAt))
    .limit(1);

  if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
    res.status(410).json({ error: "no live challenge for that bot and handle — ask for a new one" });
    return;
  }

  let found;
  try {
    found = await findNoncePost(handle, challenge.challenge);
  } catch (e) {
    const err = e as BlueskyError;
    // Unreachable is UNKNOWN, not unproven: leave the challenge live so a
    // retry costs nothing, and say which of the two happened.
    res.status(err.status ?? 502).json({ error: err.message, proved: false, retryable: true });
    return;
  }
  if (!found) {
    res.status(404).json({
      error: "no recent post from that account contains the phrase",
      proved: false,
      retryable: true,
      expected: challenge.challenge,
    });
    return;
  }

  // Consume first: a proof is single-use, and a replay must not re-link.
  await db.update(authChallengesTable)
    .set({ consumed: true })
    .where(eq(authChallengesTable.id, challenge.id));

  await db.update(userBotsTable)
    .set({ bskyHandle: handle, bskyVerifiedAt: new Date() })
    .where(and(eq(userBotsTable.obcBotId, obcBotId), eq(userBotsTable.userId, userId)));

  res.json({
    proved: true,
    handle,
    obcBotId,
    principal: `obc:${obcBotId}`,
    post: { uri: found.uri, postedAt: found.postedAt },
  });
});
