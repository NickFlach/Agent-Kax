import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";

/**
 * Link a SpaceChild identity to the signed-in KAX account (ADR-0041 Phase B).
 *
 * Why: SpaceChild federation (POST /auth/token/exchange) maps by EMAIL — which
 * silently can't serve wallet-first KAX accounts whose email column is null.
 * This flow lets such a user prove a SpaceChild identity via SpaceChild's own
 * authorization-code SSO (no password ever touches KAX) and claims the proven
 * email onto their KAX row, after which federation resolves to THIS account.
 *
 *   GET /auth/spacechild/link      (session) -> redirect to SpaceChild authorize
 *   GET /auth/spacechild/callback  (session) -> exchange code, link email,
 *                                              redirect back to /bots?spacechild=...
 *
 * CSRF: SpaceChild's authorize does not round-trip a state param, so the state
 * channel is our own short-lived httpOnly nonce cookie set at /link and
 * required (then cleared) at /callback — a forged callback link sent to a
 * victim fails because their browser never received the nonce.
 */

const SPACECHILD_AUTH_URL = (process.env.SPACECHILD_AUTH_URL || "https://auth.spacechild.love").replace(/\/+$/, "");
const KAX_PUBLIC_URL = (process.env.KAX_PUBLIC_URL || "https://kax.ninja-portal.com").replace(/\/+$/, "");
const SC_SUBDOMAIN = "kax";
const NONCE_COOKIE = "sc_link_nonce";

const router: IRouter = Router();

router.get("/auth/spacechild/link", requireAuth, (req, res) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  res.cookie(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/api/auth/spacechild",
  });
  const authorize = new URL(`${SPACECHILD_AUTH_URL}/auth/sso/authorize`);
  authorize.searchParams.set("subdomain", SC_SUBDOMAIN);
  authorize.searchParams.set("callback", `${KAX_PUBLIC_URL}/api/auth/spacechild/callback`);
  res.redirect(authorize.toString());
});

router.get("/auth/spacechild/callback", requireAuth, async (req, res) => {
  const back = (q: string) => res.redirect(`/bots?spacechild=${encodeURIComponent(q)}`);

  // CSRF gate: the linking intent must have originated from THIS browser.
  const nonce = (req as { cookies?: Record<string, string> }).cookies?.[NONCE_COOKIE];
  res.clearCookie(NONCE_COOKIE, { path: "/api/auth/spacechild" });
  if (!nonce) { back("error:link not initiated from this session"); return; }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) { back("error:missing authorization code"); return; }

  // Exchange the code with SpaceChild — the response carries the proven user.
  let scUser: { id?: string; email?: string } | undefined;
  try {
    const r = await fetch(`${SPACECHILD_AUTH_URL}/auth/sso/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, subdomain: SC_SUBDOMAIN }),
      signal: AbortSignal.timeout(10_000),
    });
    const d = (await r.json().catch(() => null)) as { user?: typeof scUser; error?: string } | null;
    if (!r.ok || !d?.user) { back(`error:${d?.error || `SpaceChild exchange failed (${r.status})`}`); return; }
    scUser = d.user;
  } catch (err) {
    back(`error:SpaceChild unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const email = (scUser.email || "").trim().toLowerCase();
  if (!email) { back("error:SpaceChild account has no email"); return; }

  const userId = req.user!.id;
  const [me] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!me || me.disabledAt) { back("error:account unavailable"); return; }

  const mine = (me.email || "").trim().toLowerCase();
  if (mine === email) { back("linked"); return; } // already aligned
  if (mine) { back(`error:this KAX account already has email ${mine} — it does not match your SpaceChild email`); return; }

  // Claim the proven email onto this (previously email-less) account. A unique
  // conflict means another KAX account owns it — never silently steal.
  const [taken] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${email}`)
    .limit(1);
  if (taken) { back("error:that email already belongs to another KAX account"); return; }

  try {
    await db.update(usersTable).set({ email }).where(eq(usersTable.id, userId));
    req.log?.info?.({ userId, email, spacechildUserId: scUser.id }, "spacechild identity linked");
    back("linked");
  } catch {
    back("error:could not save the link — try again");
  }
});

export default router;
