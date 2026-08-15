import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, userBotsTable, usersTable, agentsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireWalletAuth } from "../middlewares/requireWalletAuth";
import { mayChangeBot } from "../middlewares/botAttachAuth";

const router: Router = Router();

const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /auth/bots — list every OBC bot attached to the current user.
 */
router.get("/auth/bots", requireAuth, async (req, res) => {
  // The stored name is inferred from the artifact that proved control, and
  // that lookup can come back empty — which left the bots list showing a bare
  // UUID for a bot whose name the rest of the system knows perfectly well.
  // The agents table already carries it (the harvester keeps it current), so
  // fall back to that rather than making anyone re-attach or backfill.
  const bots = await db
    .select({
      id: userBotsTable.id,
      obcBotId: userBotsTable.obcBotId,
      displayName: userBotsTable.displayName,
      knownName: agentsTable.displayName,
      attachedAt: userBotsTable.attachedAt,
    })
    .from(userBotsTable)
    .leftJoin(agentsTable, eq(agentsTable.obcBotId, userBotsTable.obcBotId))
    .where(eq(userBotsTable.userId, req.user!.id))
    .orderBy(userBotsTable.attachedAt);

  res.json({
    bots: bots.map((b) => ({
      id: b.id,
      obcBotId: b.obcBotId,
      displayName: b.displayName ?? b.knownName ?? null,
      /** Where the name came from, so a blank one is diagnosable. */
      nameSource: b.displayName ? "attachment" : b.knownName ? "harvested" : "unknown",
      attachedAt: b.attachedAt,
    })),
  });
});

/**
 * PATCH /auth/bots/:botId — rename an attached bot.
 *
 * The inferred name is a starting point, not a decision. Renaming needs the
 * same wallet proof attaching does: a name is how the city addresses something
 * you own, and a session that could never have attached it should not be able
 * to relabel it.
 */
router.patch("/auth/bots/:botId", requireAuth, async (req, res) => {
  const raw = req.params["botId"];
  const botId = (typeof raw === "string" ? raw : "").toLowerCase();
  if (!BOT_ID_RE.test(botId)) {
    res.status(400).json({ error: "botId must be an OBC bot UUID" });
    return;
  }
  // Renaming is a CHANGE to an existing attachment, so it needs at least the
  // credential that made it. A wallet-attached bot stays wallet-only (#112).
  if (!(await mayChangeBot(req, res, botId))) return;
  const body = (req.body ?? {}) as { displayName?: unknown };
  if (typeof body.displayName !== "string") {
    res.status(400).json({ error: "displayName required" });
    return;
  }
  const name = body.displayName.trim();
  if (name.length < 1 || name.length > 40) {
    res.status(400).json({ error: "displayName must be 1-40 characters" });
    return;
  }
  const [updated] = await db
    .update(userBotsTable)
    .set({ displayName: name })
    .where(and(eq(userBotsTable.userId, req.user!.id), eq(userBotsTable.obcBotId, botId)))
    .returning({ obcBotId: userBotsTable.obcBotId, displayName: userBotsTable.displayName });
  if (!updated) {
    // Same non-disclosure as detach: never reveal whether it belongs elsewhere.
    res.status(404).json({ error: "not attached to you" });
    return;
  }
  res.json({ bot: updated });
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
router.delete("/auth/bots/:botId", requireAuth, async (req, res) => {
  const botIdRaw = req.params.botId;
  const botId = (typeof botIdRaw === "string" ? botIdRaw : "").toLowerCase();
  if (!BOT_ID_RE.test(botId)) {
    res.status(400).json({ error: "botId must be an OBC bot UUID" });
    return;
  }
  // #112 in its original form: a weaker credential must not undo a stronger
  // attestation. Expressed directly now rather than via a blanket wallet
  // requirement, so a session-attached bot can be detached by that session
  // while a wallet-attached one still cannot.
  if (!(await mayChangeBot(req, res, botId))) return;
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
