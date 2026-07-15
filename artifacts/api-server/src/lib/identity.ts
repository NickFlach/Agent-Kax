/**
 * identity.ts — KAX as the constellation identity provider (ADR-0041 Phase 1).
 *
 * KAX issues short-lived, asymmetrically-signed (Ed25519 / EdDSA) identity
 * tokens that the other constellation surfaces (observatory, radio hub) verify
 * LOCALLY against KAX's published JWKS — no per-request introspection. This
 * module owns the signing keys, token minting, and the hardened verifier.
 *
 * The hardening here is a direct response to the ADR-0041 adversarial review:
 *  - alg allowlist pinned to EdDSA (rejects alg=none and HMAC-with-public-key
 *    algorithm-confusion — jose enforces `algorithms` and never treats an
 *    asymmetric public key as an HMAC secret).
 *  - exp / iat / nbf required, short TTL (minutes) so a leaked token dies fast.
 *  - `kid` in every token header; verification selects the key by kid, and the
 *    JWKS may carry retired public keys during a rotation overlap window.
 *  - fail-closed: no keys configured => issuing AND verifying both refuse,
 *    never fall back to an insecure default.
 *
 * Keys are loaded from the environment (never generated in prod — an ephemeral
 * key would silently invalidate every live token on restart):
 *   KAX_IDENTITY_PRIVATE_JWK   the current SIGNING key, an Ed25519 private JWK
 *                              (JSON). Its `kid` (or its RFC-7638 thumbprint)
 *                              names it in the JWKS and token headers.
 *   KAX_IDENTITY_PUBLIC_JWKS   optional JSON array of additional PUBLIC JWKs to
 *                              keep in the JWKS during key rotation, so tokens
 *                              signed by a just-retired key still verify.
 *   KAX_IDENTITY_ISSUER        the `iss` claim / expected issuer
 *                              (default https://kax.ninja-portal.com).
 */

import crypto from "node:crypto";
import {
  SignJWT,
  jwtVerify,
  importJWK,
  calculateJwkThumbprint,
  type JWK,
  type JWTPayload,
} from "jose";

// jose v6 removed the `KeyLike` alias; importJWK resolves to a CryptoKey (or a
// Uint8Array for symmetric keys, which we never use here).
type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

export const IDENTITY_ALG = "EdDSA" as const;
export const ISSUER = process.env["KAX_IDENTITY_ISSUER"] || "https://kax.ninja-portal.com";

// Token lifetimes. Short by design — hard revocation (a jti blocklist the
// verifiers poll) is a follow-up; until then, a small TTL is the primary
// containment for a leaked user/agent token.
export const USER_TOKEN_TTL_SEC = 15 * 60;
export const AGENT_TOKEN_TTL_SEC = 15 * 60;

export type PrincipalKind = "user" | "agent" | "service";

export interface IdentityClaims extends JWTPayload {
  kind: PrincipalKind;
  /** For agent tokens: the OBC bot UUID this principal proved control of. */
  bot_id?: string;
  /** Capability scopes, e.g. ["propose", "trade"]. */
  scopes?: string[];
}

interface SigningKey {
  kid: string;
  privateKey: ImportedKey;
  publicJwk: JWK; // includes kid, alg, use
}

interface LoadedKeys {
  signer: SigningKey | null;
  /** Every public JWK to publish: the signer's plus any retired ones. */
  publicJwks: JWK[];
  /** kid -> imported public key, for verification. */
  verifiers: Map<string, ImportedKey>;
}

let cache: LoadedKeys | null = null;

function parseJwk(raw: string, label: string): JWK {
  let jwk: unknown;
  try {
    jwk = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!jwk || typeof jwk !== "object") throw new Error(`${label} is not a JWK object`);
  return jwk as JWK;
}

async function importPublic(jwk: JWK): Promise<{ kid: string; key: ImportedKey; publicJwk: JWK }> {
  // Strip any private material defensively before treating as public.
  const { d: _d, ...pub } = jwk as JWK & { d?: string };
  const kid = pub.kid || (await calculateJwkThumbprint(pub as JWK));
  const publicJwk: JWK = { ...pub, kid, alg: IDENTITY_ALG, use: "sig" };
  const key = (await importJWK(publicJwk, IDENTITY_ALG)) as ImportedKey;
  return { kid, key, publicJwk };
}

/**
 * Load and cache the signing + verification keys from the environment.
 * Idempotent; returns a structure with `signer === null` when no signing key
 * is configured (issuing is then disabled — fail closed).
 */
export async function loadKeys(): Promise<LoadedKeys> {
  if (cache) return cache;

  const publicJwks: JWK[] = [];
  const verifiers = new Map<string, ImportedKey>();
  let signer: SigningKey | null = null;

  const rawPriv = process.env["KAX_IDENTITY_PRIVATE_JWK"];
  if (rawPriv) {
    const privJwk = parseJwk(rawPriv, "KAX_IDENTITY_PRIVATE_JWK");
    if (privJwk.kty !== "OKP" || (privJwk as JWK & { crv?: string }).crv !== "Ed25519") {
      throw new Error("KAX_IDENTITY_PRIVATE_JWK must be an Ed25519 (OKP/Ed25519) key");
    }
    const kid = privJwk.kid || (await calculateJwkThumbprint(privJwk));
    const privateKey = (await importJWK({ ...privJwk, alg: IDENTITY_ALG }, IDENTITY_ALG)) as ImportedKey;
    // Public JWK = the private JWK minus `d` (the private scalar). For an OKP
    // key the `x` member already IS the public key, so stripping `d` yields a
    // valid public JWK — and avoids exportJWK(), which throws on the
    // non-extractable CryptoKey that importJWK returns.
    const { d: _priv, ...pubFields } = privJwk as JWK & { d?: string };
    const publicJwk: JWK = { ...pubFields, kid, alg: IDENTITY_ALG, use: "sig" };
    signer = { kid, privateKey, publicJwk };
    publicJwks.push(publicJwk);
    verifiers.set(kid, (await importJWK(publicJwk, IDENTITY_ALG)) as ImportedKey);
  }

  const rawExtra = process.env["KAX_IDENTITY_PUBLIC_JWKS"];
  if (rawExtra) {
    let arr: unknown;
    try {
      arr = JSON.parse(rawExtra);
    } catch {
      throw new Error("KAX_IDENTITY_PUBLIC_JWKS is not valid JSON");
    }
    if (!Array.isArray(arr)) throw new Error("KAX_IDENTITY_PUBLIC_JWKS must be a JSON array of JWKs");
    for (const entry of arr) {
      const { kid, key, publicJwk } = await importPublic(entry as JWK);
      if (verifiers.has(kid)) continue; // signer already registered this kid
      verifiers.set(kid, key);
      publicJwks.push(publicJwk);
    }
  }

  cache = { signer, publicJwks, verifiers };
  return cache;
}

/** Reset the key cache — for tests that swap env between cases. */
export function _resetKeyCache(): void {
  cache = null;
}

export function issuingEnabled(): boolean {
  return !!process.env["KAX_IDENTITY_PRIVATE_JWK"];
}

/** The public JWKS document to publish at the well-known endpoint. */
export async function getPublicJwks(): Promise<{ keys: JWK[] }> {
  const { publicJwks } = await loadKeys();
  return { keys: publicJwks };
}

export interface IssueOptions {
  kind: PrincipalKind;
  subject: string;
  botId?: string;
  scopes?: string[];
  ttlSeconds: number;
  /** Seconds since epoch; injectable for deterministic tests. */
  now?: number;
}

/**
 * Mint a signed identity token. Throws if no signing key is configured
 * (fail closed) — callers must surface that as 503, never issue an unsigned
 * or symmetric fallback.
 */
export async function issueToken(opts: IssueOptions): Promise<string> {
  const { signer } = await loadKeys();
  if (!signer) throw new Error("identity signing key not configured (KAX_IDENTITY_PRIVATE_JWK unset)");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();

  const claims: IdentityClaims = { kind: opts.kind };
  if (opts.botId) claims.bot_id = opts.botId;
  if (opts.scopes && opts.scopes.length) claims.scopes = opts.scopes;

  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: IDENTITY_ALG, kid: signer.kid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setSubject(opts.subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + opts.ttlSeconds)
    .setJti(jti)
    .sign(signer.privateKey);
}

export interface VerifyResult {
  ok: true;
  claims: IdentityClaims;
}
export interface VerifyFailure {
  ok: false;
  error: string;
}

/**
 * Verify a KAX-issued token against the locally-loaded public keys. Pins the
 * EdDSA algorithm (rejecting alg=none and any HMAC confusion), requires the
 * issuer, and — via jose — enforces exp/nbf with a small clock tolerance.
 * Fails closed if no keys are configured. This is the same logic the remote
 * verifiers (observatory, radio) run against the fetched JWKS.
 */
export async function verifyToken(token: string): Promise<VerifyResult | VerifyFailure> {
  const { verifiers } = await loadKeys();
  if (verifiers.size === 0) return { ok: false, error: "no verification keys configured" };
  try {
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const kid = header.kid;
        if (!kid || !verifiers.has(kid)) throw new Error("unknown or missing kid");
        return verifiers.get(kid)!;
      },
      { issuer: ISSUER, algorithms: [IDENTITY_ALG], clockTolerance: 5, requiredClaims: ["exp", "iat", "sub", "kind"] },
    );
    const kind = (payload as IdentityClaims).kind;
    if (kind !== "user" && kind !== "agent" && kind !== "service") {
      return { ok: false, error: "invalid principal kind" };
    }
    return { ok: true, claims: payload as IdentityClaims };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
