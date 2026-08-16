/**
 * Where this deployment lives, resolved once for everyone who needs it.
 *
 * The two ends of the Stripe round trip used to answer this question
 * differently. Checkout (routes/store-checkout.ts) resolved
 * KAX_PUBLIC_URL -> REPLIT_DEV_DOMAIN -> REPLIT_DOMAINS and refused with a named
 * 503 when none was set. The managed webhook registration (index.ts) built its
 * URL from REPLIT_DOMAINS ALONE.
 *
 * So an operator who read the 503 — which names KAX_PUBLIC_URL first — and set
 * only that variable got a checkout that worked perfectly and a webhook
 * registered at `https://undefined/api/webhooks/stripe`. Customers charged,
 * `checkout.session.completed` never delivered, and nothing visibly wrong from
 * either end: the redirect looks healthy and the Stripe dashboard shows an
 * endpoint exists. Settlement simply never happens.
 *
 * One function now, so the two ends cannot disagree again — the divergence was
 * not a bug in either site, it was the existence of two answers.
 *
 * The precedence is the checkout's, kept deliberately:
 *   - KAX_PUBLIC_URL is an absolute URL the operator chose. It wins.
 *   - REPLIT_DEV_DOMAIN / REPLIT_DOMAINS are bare hostnames the platform hands
 *     to the process, so a Replit deployment needs nothing provisioned.
 *   - PUBLIC_APP_URL is deliberately NOT consulted; its only readers take it as
 *     `?? ""`, so an unset value yields a relative URL that Stripe rejects at
 *     session creation — a broken checkout instead of a named missing variable
 *     (KAX-ADR-0002).
 *
 * Null means nothing is configured, and every caller must treat that as a
 * refusal rather than substituting a default. Returning a buyer to the wrong
 * host after a real charge is worse than never taking the charge, and a
 * refusal is a deploy-time error where a fallback is a live vulnerability.
 */

/** The env shape this reads, so it can be tested without touching process.env. */
export interface BaseUrlEnv {
  KAX_PUBLIC_URL?: string | undefined;
  REPLIT_DEV_DOMAIN?: string | undefined;
  REPLIT_DOMAINS?: string | undefined;
}

/**
 * Resolve the canonical public base URL, without a trailing slash.
 *
 * Pure: pass the env in. `publicBaseUrl()` below is the process-wide caller.
 */
export function resolvePublicBaseUrl(env: BaseUrlEnv): string | null {
  const override = (env.KAX_PUBLIC_URL || "").trim();

  // A set-but-schemeless override is a misconfiguration, not an absence, and it
  // is the likely one: the variables beneath it are bare hosts, so
  // `KAX_PUBLIC_URL=kax.example.com` is the natural mistake. Falling through to
  // the platform domain would hide the typo behind a checkout that quietly
  // returns buyers somewhere the operator did not choose.
  if (override && !/^https?:\/\//.test(override)) return null;
  if (override) return override.replace(/\/+$/, "");

  const replitDomain = (
    env.REPLIT_DEV_DOMAIN || (env.REPLIT_DOMAINS || "").split(",")[0] || ""
  ).trim();
  if (replitDomain) return `https://${replitDomain.replace(/\/+$/, "")}`;

  return null;
}

/** The same answer, for the running process. */
export function publicBaseUrl(): string | null {
  return resolvePublicBaseUrl({
    KAX_PUBLIC_URL: process.env["KAX_PUBLIC_URL"],
    REPLIT_DEV_DOMAIN: process.env["REPLIT_DEV_DOMAIN"],
    REPLIT_DOMAINS: process.env["REPLIT_DOMAINS"],
  });
}

/** The message shown when nothing is configured. Named variables, not advice. */
export const NO_PUBLIC_URL_MESSAGE =
  "no canonical public URL is configured. Set KAX_PUBLIC_URL to an absolute URL " +
  "including its https:// scheme (or set REPLIT_DEV_DOMAIN / REPLIT_DOMAINS, which are " +
  "bare hostnames).";
