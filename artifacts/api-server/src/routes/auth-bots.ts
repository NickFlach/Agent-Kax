import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, userBotsTable } from "@workspace/db";
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
    .where(eq(userBotsTable.userId, req.user!.id));
  res.json({ bots });
});

/**
 * DELETE /auth/bots/:botId — detach an OBC bot from the current user.
 * 404 if the user doesn't own that attachment (no information leak —
 * we don't say whether the bot is attached to someone else).
 */
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
  res.json({ ok: true, detached: botId });
});

export default router;
