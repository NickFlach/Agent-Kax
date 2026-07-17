import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, userBotsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import {
  getPublicJwks,
  issueToken,
  issuingEnabled,
  verifyToken,
  USER_TOKEN_TTL_SEC,
  AGENT_TOKEN_TTL_SEC,
  MAX_TOKEN_LIFETIME_SEC,
} from "../lib/identity";
import { postTransaction } from "../lib/ledger";
import { HOUSE_ACCOUNT } from "../lib/ledger-core";

const router: IRouter = Router();

// Starting play credits granted once per principal, the first time they mint
// an identity token (100 credits in minor units). The txId is DETERMINISTIC
// (`grant:signup:<principal>`), so the ledger's idempotency registry makes the
// grant exactly-once no matter how many tokens the principal mints — no flag
// column, no separate bookkeeping. Best-effort: a ledger hiccup never blocks
// token issuance.
const SIGNUP_GRANT_MINOR = 100_000_000n;

async function grantSignupCredits(principal: string, log?: (obj: unknown, msg: string) => void): Promise<void> {
  try {
    const r = await postTransaction({
      txId: `grant:signup:${principal}`,
      asset: "play_credit",
      postings: [
        { account: HOUSE_ACCOUNT, amount: -SIGNUP_GRANT_MINOR, kind: "grant", ref: "signup grant" },
        { account: `trader:${principal}`, amount: SIGNUP_GRANT_MINOR, kind: "grant", ref: "signup grant" },
      ],
    });
    if (!r.idempotentReplay) log?.({ principal }, "signup grant issued");
  } catch (err) {
    log?.({ err, principal }, "signup grant failed (token still issued)");
  }
}

const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public JWKS — the constellation's verifiers (observatory, radio) fetch this
 * to check KAX-issued token signatures locally. Cache-friendly; safe to serve
 * anonymously (public keys only).
 */
router.get("/auth/jwks.json", async (_req, res) => {
  const jwks = await getPublicJwks();
  res.set("Cache-Control", "public, max-age=300");
  res.json(jwks);
});

/**
 * Mint an identity token for the signed-in user.
 *
 *   POST /auth/token                     -> a `user` token (sub = user id)
 *   POST /auth/token { obcBotId }        -> an `agent` token (sub = user id,
 *                                           bot_id = the owned OBC bot) — only
 *                                           if the caller has PROVEN control of
 *                                           that bot via the agent-verify flow
 *                                           (it is in their user_bots).
 *
 * The agent token's authority is bound to a bot the user actually controls;
 * the token never asserts a bot_id the server has not seen proven, which is
 * the ADR-0041 fix for "claim any harvested bot id".
 */
router.post("/auth/token", requireAuth, async (req, res) => {
  if (!issuingEnabled()) {
    res.status(503).json({ error: "identity issuing disabled: KAX_IDENTITY_PRIVATE_JWK unset" });
    return;
  }
  const userId = req.user!.id;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || user.disabledAt) {
    res.status(403).json({ error: "account disabled" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const obcBotIdRaw = typeof body.obcBotId === "string" ? body.obcBotId : "";

  try {
    if (obcBotIdRaw) {
      if (!BOT_ID_RE.test(obcBotIdRaw)) {
        res.status(400).json({ error: "obcBotId must be an OBC bot UUID" });
        return;
      }
      const obcBotId = obcBotIdRaw.toLowerCase();
      // The bot must be PROVEN-owned by this user (agent-verify flow populated
      // user_bots). No token is minted for a bot the user hasn't attached.
      const [owned] = await db
        .select()
        .from(userBotsTable)
        .where(and(eq(userBotsTable.userId, userId), eq(userBotsTable.obcBotId, obcBotId)))
        .limit(1);
      if (!owned) {
        res.status(403).json({ error: "you have not proven control of that bot — attach it first via /auth/agent/verify" });
        return;
      }
      const token = await issueToken({
        kind: "agent",
        subject: userId,
        botId: obcBotId,
        scopes: ["propose", "trade"],
        ttlSeconds: AGENT_TOKEN_TTL_SEC,
      });
      // Principal grammar mirrors the hub's traderIdFromClaims exactly.
      await grantSignupCredits(`kax:agent:${obcBotId}`, req.log?.info?.bind(req.log));
      res.json({ token, kind: "agent", botId: obcBotId, expiresInSec: AGENT_TOKEN_TTL_SEC });
      return;
    }

    const token = await issueToken({
      kind: "user",
      subject: userId,
      scopes: ["propose", "trade"],
      ttlSeconds: USER_TOKEN_TTL_SEC,
    });
    await grantSignupCredits(`kax:user:${userId}`, req.log?.info?.bind(req.log));
    res.json({ token, kind: "user", expiresInSec: USER_TOKEN_TTL_SEC });
  } catch (err) {
    req.log?.error?.({ err, userId }, "token issue failed");
    res.status(500).json({ error: "failed to issue token" });
  }
});

/**
 * Refresh a STILL-VALID identity token — the autonomy path for CLI / swarm
 * agents (ADR-0041). The 15-minute TTL is right for humans pasting tokens into
 * a dashboard but unusable for an unattended agent; this lets an agent present
 * its current (unexpired) token and receive a fresh one with the same claims.
 *
 * Bounds and checks:
 *  - The incoming token must VERIFY (signature, issuer, exp) — an expired or
 *    forged token cannot refresh. No session cookie needed: the token IS the
 *    credential.
 *  - The `oat` (original-auth-time) claim is carried through every refresh;
 *    once the lineage is older than MAX_TOKEN_LIFETIME_SEC (default 30 days)
 *    refreshing refuses and the human must re-authenticate. A stolen token
 *    can't ride refreshes forever.
 *  - The subject must still be a live, non-disabled user; agent tokens must
 *    still have their bot attached (detaching a bot revokes its lineage).
 */
router.post("/auth/token/refresh", async (req, res) => {
  if (!issuingEnabled()) {
    res.status(503).json({ error: "identity issuing disabled: KAX_IDENTITY_PRIVATE_JWK unset" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bearer = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const token = typeof body.token === "string" && body.token ? body.token : bearer;
  if (!token) {
    res.status(400).json({ error: "provide the current token (body.token or Authorization: Bearer)" });
    return;
  }

  const v = await verifyToken(token);
  if (!v.ok) {
    res.status(401).json({ error: `token did not verify: ${v.error} — re-authenticate on KAX to mint a new one` });
    return;
  }
  const claims = v.claims;
  const now = Math.floor(Date.now() / 1000);
  // Legacy tokens (pre-oat) age from their iat.
  const oat = typeof claims.oat === "number" ? claims.oat : (claims.iat as number);
  if (now - oat > MAX_TOKEN_LIFETIME_SEC) {
    res.status(401).json({ error: "token lineage exceeded its maximum lifetime — re-authenticate on KAX" });
    return;
  }

  // The subject must still be in good standing (this is the revocation hook:
  // disable the user, or detach the bot, and the lineage dies at next refresh).
  const userId = claims.sub as string;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || user.disabledAt) {
    res.status(403).json({ error: "account disabled or gone" });
    return;
  }
  if (claims.kind === "agent") {
    const botId = (claims.bot_id || "").toLowerCase();
    const [owned] = await db
      .select()
      .from(userBotsTable)
      .where(and(eq(userBotsTable.userId, userId), eq(userBotsTable.obcBotId, botId)))
      .limit(1);
    if (!owned) {
      res.status(403).json({ error: "bot no longer attached to this account" });
      return;
    }
  }

  try {
    const ttl = claims.kind === "agent" ? AGENT_TOKEN_TTL_SEC : USER_TOKEN_TTL_SEC;
    const fresh = await issueToken({
      kind: claims.kind,
      subject: userId,
      botId: claims.kind === "agent" ? (claims.bot_id as string) : undefined,
      scopes: Array.isArray(claims.scopes) ? (claims.scopes as string[]) : undefined,
      ttlSeconds: ttl,
      originalAuthTime: oat,
    });
    res.json({
      token: fresh,
      kind: claims.kind,
      ...(claims.kind === "agent" ? { botId: claims.bot_id } : {}),
      expiresInSec: ttl,
      lineageExpiresInSec: Math.max(0, MAX_TOKEN_LIFETIME_SEC - (now - oat)),
    });
  } catch (err) {
    req.log?.error?.({ err, userId }, "token refresh failed");
    res.status(500).json({ error: "failed to refresh token" });
  }
});

export default router;
