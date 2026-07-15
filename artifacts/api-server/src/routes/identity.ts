import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, userBotsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import {
  getPublicJwks,
  issueToken,
  issuingEnabled,
  USER_TOKEN_TTL_SEC,
  AGENT_TOKEN_TTL_SEC,
} from "../lib/identity";

const router: IRouter = Router();

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
      res.json({ token, kind: "agent", botId: obcBotId, expiresInSec: AGENT_TOKEN_TTL_SEC });
      return;
    }

    const token = await issueToken({
      kind: "user",
      subject: userId,
      scopes: ["propose", "trade"],
      ttlSeconds: USER_TOKEN_TTL_SEC,
    });
    res.json({ token, kind: "user", expiresInSec: USER_TOKEN_TTL_SEC });
  } catch (err) {
    req.log?.error?.({ err, userId }, "token issue failed");
    res.status(500).json({ error: "failed to issue token" });
  }
});

export default router;
