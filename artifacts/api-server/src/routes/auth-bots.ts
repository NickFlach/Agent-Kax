import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, userBotsTable, usersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireWalletAuth } from "../middlewares/requireWalletAuth";

const router: Router = Router();

const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /auth/bots — list every OBC bot attached to the current user.
 */
router.get("/auth/bots", requireAuth, async (req, res) => {
  const bots = await db
    .select({
      id: userBotsTable.id,
      obcBotId: userBotsTable.obcBotId,
      displayName: userBotsTable.displayName,
      attachedAt: userBotsTable.attachedAt,
    })
    .from(userBotsTable)
    .where(eq(userBotsTable.userId, req.user!.id))
    .orderBy(userBotsTable.attachedAt);
  res.json({ bots });
});

/**
 * DELETE /auth/bots/:botId — detach an OBC bot from the current user.
 * 404 if the user doesn't own that attachment (no information leak —
 * we don't say whether the bot is attached to someone else).
 */
// Detaching is attachment management, so it needs the same proof attaching
// does. Attaching goes through requireWalletAuth (see /auth/agent/challenge and
// /auth/agent/verify); this route only required requireAuth, so a grandfathered
// `obc_agent:` session with no wallet could DETACH a bot it could never have
// attached — undoing a wallet-proven attestation without holding the wallet.
// (#112)
router.delete("/auth/bots/:botId", requireWalletAuth, async (req, res) => {
  const botIdRaw = req.params.botId;
  const botId = (typeof botIdRaw === "string" ? botIdRaw : "").toLowerCase();
  if (!BOT_ID_RE.test(botId)) {
    res.status(400).json({ error: "botId must be an OBC bot UUID" });
    return;
  }
  const deleted = await db
    .delete(userBotsTable)
    .where(and(
      eq(userBotsTable.obcBotId, botId),
      eq(userBotsTable.userId, req.user!.id),
    ))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  // Deleting the user_bots row is not enough for a grandfathered user.
  // `users.obc_bot_id` is the legacy single-bot field, and authMiddleware
  // lazily re-creates a user_bots row from it on EVERY request carrying an
  // `obc_agent:` session — so the bot the owner just detached reappeared on
  // their very next request, with no proof step, for as long as that session
  // lived. Clearing the legacy field is what makes detach authoritative; the
  // lazy backfill then has nothing to resurrect. (#155)
  //
  // Scoped to this user AND to the bot actually being detached, so a user with
  // several bots does not lose the legacy pointer to a different one. Compared
  // lowercased because `botId` is normalised above while the legacy column was
  // written before that normalisation existed.
  await db
    .update(usersTable)
    .set({ obcBotId: null })
    .where(and(
      eq(usersTable.id, req.user!.id),
      sql`lower(${usersTable.obcBotId}) = ${botId}`,
    ));
  res.json({ ok: true, detached: botId });
});

export default router;
