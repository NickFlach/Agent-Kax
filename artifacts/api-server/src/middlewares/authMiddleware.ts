import * as oidc from "openid-client";
import { type Request, type Response, type NextFunction } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { usersTable, userBotsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  clearSession,
  getOidcConfig,
  getSessionId,
  getSession,
  updateSession,
  type SessionData,
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

async function refreshIfExpired(
  sid: string,
  session: SessionData,
): Promise<SessionData | null> {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now <= session.expires_at) return session;

  // Non-OIDC sessions (wallet, legacy obc_agent) carry a synthetic
  // access_token of the shape "wallet:<userId>" or "obc_agent:<userId>"
  // with no refresh_token — they can't be refreshed against an issuer.
  // When they hit their expires_at, surface as null so authMiddleware
  // clears the cookie. The user then re-signs with their wallet
  // (obc_agent re-login is no longer offered as of task #21 — wallet
  // is the canonical identity).
  const token = typeof session.access_token === "string" ? session.access_token : "";
  const isOidcSession = token !== "" && !token.startsWith("wallet:") && !token.startsWith("obc_agent:");
  if (!isOidcSession) return null;

  if (!session.refresh_token) return null;

  try {
    const config = await getOidcConfig();
    const tokens = await oidc.refreshTokenGrant(
      config,
      session.refresh_token,
    );
    session.access_token = tokens.access_token;
    session.refresh_token = tokens.refresh_token ?? session.refresh_token;
    session.expires_at = tokens.expiresIn()
      ? now + tokens.expiresIn()!
      : session.expires_at;
    await updateSession(sid, session);
    return session;
  } catch {
    return null;
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

  const refreshed = await refreshIfExpired(sid, session);
  if (!refreshed) {
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
  // One bounded SELECT + at most one INSERT, only on legacy session
  // shape, so this stays cheap.
  const tokStr = typeof refreshed.access_token === "string" ? refreshed.access_token : "";
  if (tokStr.startsWith("obc_agent:")) {
    try {
      const [u] = await db
        .select({ id: usersTable.id, obcBotId: usersTable.obcBotId })
        .from(usersTable)
        .where(eq(usersTable.id, refreshed.user.id))
        .limit(1);
      if (u?.obcBotId) {
        const botId = u.obcBotId.toLowerCase();
        await db
          .insert(userBotsTable)
          .values({ userId: u.id, obcBotId: botId, displayName: refreshed.user.displayName ?? null })
          .onConflictDoNothing({ target: userBotsTable.obcBotId });
      }
    } catch (err) {
      // Lazy-backfill is best-effort: don't block the request if it fails.
      logger.warn({ err }, "obc_agent legacy backfill failed");
    }
  }

  req.user = refreshed.user;
  next();
}
