import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable, userBotsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { getSession, getSessionId } from "../lib/auth";

/**
 * Who may attach a bot, and who may undo it.
 *
 * Attaching used to require a wallet sign-in. That was never what made
 * attaching safe: control of a bot is proved by publishing a challenge phrase
 * from it, and holding an Ethereum key says nothing about whether you run
 * that bot. The wallet decided which KAX account a bot binds to, not whether
 * the binding was legitimate.
 *
 * What the gate really protected was ASYMMETRY. #112 found that a
 * grandfathered session with no wallet could DETACH a bot it could never have
 * attached — undoing a wallet-proven attestation without holding the wallet.
 * That is a genuine hole, and it is about the relationship between the two
 * operations rather than about wallets.
 *
 * So the rule is stated directly instead of approximated by a blanket
 * requirement:
 *
 *   ATTACH  needs an authenticated user and the OCC proof. The strength of
 *           the session is RECORDED.
 *   CHANGE  (rename, detach, bind another identity) needs a session at least
 *           as strong as the one that attached.
 *
 * A wallet-attached bot therefore still cannot be touched by an email-only
 * session — #112 stays fixed — while somebody who verified their bot through
 * OpenClawCity gets their store without being made to install a crypto
 * wallet first. Which is the point: the wallet is for collectors, not for
 * residents.
 */

export type AttachStrength = "wallet" | "session";

/** How strong is the session on this request? */
export async function sessionStrength(req: Request): Promise<AttachStrength | null> {
  if (!req.isAuthenticated?.()) return null;
  const sid = getSessionId(req);
  const session = sid ? await getSession(sid) : null;
  const token = session?.access_token;
  if (typeof token === "string" && token.startsWith("wallet:")) {
    // A wallet SESSION still needs the user row to carry the address, or the
    // claim is unbacked.
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (user?.walletAddress && !user.disabledAt) return "wallet";
  }
  return "session";
}

/** Attaching: any signed-in, enabled account. The OCC proof does the rest. */
export async function requireAttachAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated?.()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
  if (!user || user.disabledAt) {
    res.status(403).json({ error: "Account disabled" });
    return;
  }
  next();
}

/**
 * Changing an existing attachment: never with less than it was made with.
 *
 * Returns true when the request may proceed; answers the response itself and
 * returns false when it may not, so callers stay a single `if`.
 */
export async function mayChangeBot(req: Request, res: Response, obcBotId: string): Promise<boolean> {
  const strength = await sessionStrength(req);
  if (!strength) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  const [row] = await db
    .select({ attachedVia: userBotsTable.attachedVia })
    .from(userBotsTable)
    .where(and(eq(userBotsTable.obcBotId, obcBotId), eq(userBotsTable.userId, req.user!.id)))
    .limit(1);

  // Nothing attached, or not yours. Let the route answer 404 on its own terms
  // rather than leaking which of the two it is.
  if (!row) return true;

  if (row.attachedVia === "wallet" && strength !== "wallet") {
    res.status(403).json({
      error: "this bot was attached with a wallet, so changing it needs the wallet",
    });
    return false;
  }
  return true;
}
