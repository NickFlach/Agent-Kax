import { Router } from "express";
import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import {
  db,
  usersTable,
  authChallengesTable,
} from "@workspace/db";
import { createSession, SESSION_COOKIE, SESSION_TTL } from "../lib/auth";
import { getPartnerArtifact, partnerApiAvailable } from "../lib/partnerClient";

const router: Router = Router();

const CHALLENGE_TTL_MS = 30 * 60 * 1000; // 30 min — user must create an OBC artifact in this window
const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = BOT_ID_RE;

function generateChallenge(): string {
  // 6-char hex is wide enough (~16M combos) so brute-force-injecting it
  // into someone else's already-published artifact is statistically
  // infeasible inside the 30-minute window.
  const tail = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `KAX-VERIFY-${tail}`;
}

/**
 * Step 1: client posts the OBC bot UUID they're claiming. We mint a
 * verification phrase keyed to that bot id, valid for 30 minutes. The
 * client shows the phrase to the user and instructs them to publish
 * an OBC artifact (any kind — image, text, music) whose description
 * contains the phrase. The artifact must be created by this exact
 * bot_id (verified server-side in step 2 against the partner API).
 */
router.post("/auth/agent/challenge", async (req, res) => {
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
  // Sweep any expired rows for this subject. Bounded, cheap.
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
    claimSubject: obcBotId.toLowerCase(),
    consumed: false,
    expiresAt,
  });
  res.json({
    challenge,
    expiresAt: expiresAt.toISOString(),
    instruction:
      `Create any artifact on OpenBotCity from bot ${obcBotId} whose description contains the phrase ${challenge}. ` +
      `Then POST { obcBotId, artifactUuid } to /api/auth/agent/verify with the new artifact's UUID.`,
  });
});

/**
 * Step 2: client posts { obcBotId, artifactUuid } once the artifact is
 * published. Server fetches the artifact via the partner API and
 * confirms:
 *   (a) artifact.creator_bot_id === claimed obcBotId
 *   (b) artifact.description contains the unconsumed challenge phrase
 *   (c) artifact.created_at >= challenge.createdAt (so an artifact
 *       published BEFORE the challenge was issued can't be replayed)
 * On success: consume the challenge, upsert a user keyed by obcBotId,
 * issue a session cookie.
 */
router.post("/auth/agent/verify", async (req, res) => {
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
  // Latest unconsumed challenge for this bot id.
  const [challenge] = await db
    .select()
    .from(authChallengesTable)
    .where(and(
      eq(authChallengesTable.kind, "agent_challenge"),
      eq(authChallengesTable.claimSubject, obcBotId),
      eq(authChallengesTable.consumed, false),
    ))
    .orderBy(authChallengesTable.expiresAt)
    .limit(1);
  if (!challenge || challenge.expiresAt < new Date()) {
    res.status(401).json({ error: "no active challenge — request /auth/agent/challenge first" });
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
  // Verify creator_bot_id. Some partner endpoints expose this under
  // different keys; accept the common shapes defensively.
  const creator =
    (artifact.creator_bot_id ?? (artifact as Record<string, unknown>).creator_id ?? "") as string;
  if (typeof creator !== "string" || creator.toLowerCase() !== obcBotId) {
    res.status(403).json({ error: "artifact creator does not match claimed bot id" });
    return;
  }
  // Verify the challenge phrase is present in description (or title as
  // fallback — title is much shorter, easier for short-form artifacts).
  const haystack = `${artifact.description ?? ""}\n${artifact.title ?? ""}`;
  if (!haystack.includes(challenge.challenge)) {
    res.status(403).json({ error: `artifact does not contain the challenge phrase ${challenge.challenge}` });
    return;
  }
  // Verify the artifact was created AFTER the challenge was issued, so
  // a pre-existing artifact can't be presented as proof.
  const createdAtRaw = artifact.created_at;
  if (typeof createdAtRaw === "string") {
    const createdAt = new Date(createdAtRaw);
    if (!Number.isNaN(createdAt.getTime()) && createdAt < challenge.createdAt) {
      res.status(403).json({ error: "artifact pre-dates the challenge — please create a fresh artifact" });
      return;
    }
  }
  // Atomically consume.
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
  // Upsert user by obcBotId. Use display_name from the artifact if
  // we have it (the bot's display name often travels with artifacts).
  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.obcBotId, obcBotId))
    .limit(1);
  if (!user) {
    const ad = artifact as Record<string, unknown>;
    const inferredName =
      (ad.creator_display_name as string | undefined) ??
      (ad.display_name as string | undefined) ??
      `Agent ${obcBotId.slice(0, 8)}`;
    const inserted = await db
      .insert(usersTable)
      .values({
        obcBotId,
        authProvider: "obc_agent",
        displayName: inferredName,
      })
      .returning();
    user = inserted[0]!;
  }
  if (user.disabledAt) {
    res.status(403).json({ error: "account disabled" });
    return;
  }
  const sid = await createSession({
    user: {
      id: user.id,
      email: user.email ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      profileImageUrl: user.profileImageUrl ?? null,
    },
    access_token: `obc_agent:${user.id}`,
    expires_at: Math.floor((Date.now() + SESSION_TTL) / 1000),
  });
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL,
    path: "/",
  });
  res.json({
    ok: true,
    user: {
      id: user.id,
      obcBotId: user.obcBotId,
      displayName: user.displayName,
      role: user.role,
    },
  });
});

export default router;
