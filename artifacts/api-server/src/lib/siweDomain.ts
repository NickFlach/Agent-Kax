/**
 * SIWE domain resolution.
 *
 * The domain in a Sign-In With Ethereum message is a security boundary: it is
 * what the user sees and consents to in their wallet, and what binds the
 * signature to this application.
 *
 * It was previously taken from the request:
 *
 *   const h = req.headers["x-forwarded-host"] ?? req.headers.host;
 *   return h ?? "kax.local";
 *
 * Both of those are attacker-controlled. An attacker could request a nonce with
 * `Host: evil.example`, and the server would build, persist and later ACCEPT a
 * canonical SIWE message naming `evil.example`. Because `/auth/wallet/verify`
 * deliberately ignores client-supplied message text and verifies against the
 * stored payload, a signature phished under the attacker's domain minted a real
 * KAX session. (#29)
 *
 * The domain therefore comes from server configuration only. `KAX_PUBLIC_URL`
 * is the existing convention for this service's own public origin (see
 * routes/auth-spacechild.ts), so this reuses it rather than inventing a new
 * knob.
 *
 * Multi-domain deployments can set `KAX_ALLOWED_SIWE_DOMAINS` to an explicit
 * comma-separated allowlist; a request host is then honoured ONLY if it appears
 * there. Anything else falls back to the configured domain. That keeps the
 * flexibility without ever letting an unrecognised header choose the domain.
 */

/** Default matches routes/auth-spacechild.ts so the two agree on our origin. */
export const DEFAULT_KAX_PUBLIC_URL = "https://kax.ninja-portal.com";

/** Strip scheme, any credentials, path and trailing dots from a host value. */
function normaliseHost(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  let h = value.trim();
  if (h === "") return null;
  // Accept either a bare host or a full URL.
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  h = h.split("/")[0] ?? "";
  // Drop userinfo if someone configured https://user:pass@host.
  const at = h.lastIndexOf("@");
  if (at >= 0) h = h.slice(at + 1);
  h = h.replace(/\.+$/, "").toLowerCase();
  return h === "" ? null : h;
}

/** Hosts explicitly permitted to appear as the SIWE domain, lowercased. */
export function allowedSiweDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.KAX_ALLOWED_SIWE_DOMAINS;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((d) => normaliseHost(d))
    .filter((d): d is string => d !== null);
}

/** The configured domain for this deployment. Never request-derived. */
export function configuredSiweDomain(env: NodeJS.ProcessEnv = process.env): string {
  return normaliseHost(env.KAX_PUBLIC_URL) ?? normaliseHost(DEFAULT_KAX_PUBLIC_URL)!;
}

/**
 * Resolve the domain to put in a SIWE message.
 *
 * @param requestHost the raw Host / X-Forwarded-Host value, if any. It is only
 *   ever consulted against the explicit allowlist — it can never introduce a
 *   domain the operator has not named.
 */
export function resolveSiweDomain(
  requestHost?: string | string[] | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = configuredSiweDomain(env);
  const allowed = allowedSiweDomains(env);
  if (allowed.length === 0) return configured;

  const first = Array.isArray(requestHost) ? requestHost[0] : requestHost;
  const host = normaliseHost(first);
  if (host !== null && allowed.includes(host)) return host;
  return configured;
}
