import { type Request, type Response, type NextFunction } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { usersTable, userBotsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  clearSession,
  getSessionId,
  getSession,
} from "../lib/auth";
import { logger } from "../lib/logger";

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      isAuthenticated(): this is AuthedRequest;

      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const session = await getSession(sid);
  if (!session?.user?.id) {
    await clearSession(res, sid);
    next();
    return;
  }

  // Wallet sessions (and grandfathered obc_agent sessions) carry a
  // synthetic access_token of the shape `wallet:<userId>` or
  // `obc_agent:<userId>` with no refresh path. When the session passes
  // its `expires_at`, just clear the cookie and surface as anonymous.
  // The user re-signs with their wallet to get a new session.
  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at && now > session.expires_at) {
    await clearSession(res, sid);
    next();
    return;
  }

  // Grandfathering for legacy `obc_agent:<userId>` sessions issued
  // before the wallet-primary refactor (task #21). These sessions
  // remain valid until they expire, but the bot they were minted with
  // must exist as a row in `user_bots` so the user sees it under the
  // new schema. The 0002 migration backfills `users.obc_bot_id` →
  // `user_bots`, but if a row was created between the migration and
  // this request (or via a future code path) we lazy-backfill here.
  const tokStr = typeof session.access_token === "string" ? session.access_token : "";
  if (tokStr.startsWith("obc_agent:")) {
    try {
      const [u] = await db
        .select({ id: usersTable.id, obcBotId: usersTable.obcBotId })
        .from(usersTable)
        .where(eq(usersTable.id, session.user.id))
        .limit(1);
      if (u?.obcBotId) {
        const botId = u.obcBotId.toLowerCase();
        await db
          .insert(userBotsTable)
          .values({ userId: u.id, obcBotId: botId, displayName: session.user.displayName ?? null })
          .onConflictDoNothing({ target: userBotsTable.obcBotId });
      }
    } catch (err) {
      logger.warn({ err }, "obc_agent legacy backfill failed");
    }
  }

  req.user = session.user;
  next();
}
