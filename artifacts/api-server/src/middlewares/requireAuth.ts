import { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.disabledAt) {
    res.status(403).json({ error: "Account disabled" });
    return;
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.role !== "admin" || user.disabledAt) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

/**
 * Returns true if the request is authenticated and the user owns the resource
 * (or is an admin). `ownerId` may be null for legacy/Kannaka-system rows; only
 * admins may mutate those.
 */
export async function canMutate(req: Request, ownerId: string | null): Promise<boolean> {
  if (!req.isAuthenticated()) return false;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.disabledAt) return false;
  if (user.role === "admin") return true;
  return ownerId !== null && ownerId === user.id;
}

/**
 * Determine which ownerId(s) a list/aggregate endpoint should be scoped to.
 * Regular users always see only their own data. Admins see only their own data
 * by default, but can pass `?all=true` to query across every user.
 *
 * Returns `null` to indicate "no owner filter" (admin + all=true). Otherwise
 * returns the user id to scope by.
 *
 * Must be called *after* `requireAuth` middleware.
 */
export async function getOwnerScope(req: Request): Promise<string | null> {
  const userId = req.user!.id;
  const wantsAll = req.query["all"] === "true";
  if (!wantsAll) return userId;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (user?.role === "admin") return null;
  return userId;
}

/**
 * Return the authenticated user when one exists and is in good standing —
 * otherwise null. Lets routes serve both public visitors and signed-in
 * owners from a single handler (owner sees more; public sees the
 * publishable subset).
 *
 * Unlike `requireAuth` this never short-circuits the response: callers
 * apply their own visibility logic against the returned user.
 */
export async function getOptionalAuth(req: Request): Promise<{ id: string; role: string } | null> {
  if (!req.isAuthenticated()) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
  if (!user || user.disabledAt) return null;
  return { id: user.id, role: user.role };
}

/**
 * Admin browser session OR a trusted service bearer token
 * (`Bearer $KAX_SERVICE_TOKEN`, falling back to the existing
 * `FLOOR_LEDGER_TOKEN`). Lets constellation services and maintenance
 * scripts drive admin-scoped endpoints without a cookie session. The
 * token path is disabled unless one of those env vars is set.
 */
export function requireAdminOrServiceToken(req: Request, res: Response, next: NextFunction) {
  const token = process.env.KAX_SERVICE_TOKEN || process.env.FLOOR_LEDGER_TOKEN;
  if (token && req.headers.authorization === `Bearer ${token}`) {
    next();
    return;
  }
  requireAdmin(req, res, next);
}

/**
 * Constant-time Bearer-token compare. Returns false for a missing/unset
 * expected value or a length/content mismatch. Uses `timingSafeEqual` so the
 * comparison doesn't leak the token prefix via response timing.
 */
function bearerEquals(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths — guard first (length isn't secret).
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Guards the ledger MINT surface (`/ledger/grant`, `/ledger/escrow`) — the only
 * endpoints that move value OUT of the house account, i.e. that create credits.
 * Gated on a DEDICATED `KAX_LEDGER_MINT_TOKEN`, deliberately NOT the shared
 * service token and with NO `FLOOR_LEDGER_TOKEN` fallback, so a leaked
 * read/trade credential cannot mint. Fails CLOSED (503) when the env var is
 * unset — the mint surface is off until an operator explicitly arms it.
 */
export function requireLedgerMintToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.KAX_LEDGER_MINT_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ledger mint surface disabled (KAX_LEDGER_MINT_TOKEN unset)" });
    return;
  }
  if (!bearerEquals(req, expected)) {
    res.status(401).json({ error: "invalid or missing ledger mint token" });
    return;
  }
  next();
}

/**
 * Guards the ledger TRADE surface (`/ledger/trade`, `/ledger/payout`) — value
 * moves only BETWEEN non-house accounts (trader <-> amm), never minted, so the
 * overdraft guard in postTransaction fully bounds it. Dedicated
 * `KAX_LEDGER_TRADE_TOKEN`, no fallback. Fails CLOSED (503) when unset.
 */
export function requireLedgerTradeToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.KAX_LEDGER_TRADE_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ledger trade surface disabled (KAX_LEDGER_TRADE_TOKEN unset)" });
    return;
  }
  if (!bearerEquals(req, expected)) {
    res.status(401).json({ error: "invalid or missing ledger trade token" });
    return;
  }
  next();
}
