import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, importJWK, calculateJwkThumbprint, type JWK } from "jose";

// The module reads keys from env at first use and caches; each test sets env
// then resets the cache via the module's test hook.
import {
  issueToken,
  verifyToken,
  getPublicJwks,
  issuingEnabled,
  _resetKeyCache,
  ISSUER,
  IDENTITY_ALG,
} from "./identity";

async function freshEd25519PrivateJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return exportJWK(privateKey);
}

const ENV_KEYS = ["KAX_IDENTITY_PRIVATE_JWK", "KAX_IDENTITY_PUBLIC_JWKS"];
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => { clearEnv(); _resetKeyCache(); });
afterEach(() => { clearEnv(); _resetKeyCache(); });

async function configureSigner(): Promise<JWK> {
  const jwk = await freshEd25519PrivateJwk();
  process.env.KAX_IDENTITY_PRIVATE_JWK = JSON.stringify(jwk);
  _resetKeyCache();
  return jwk;
}

describe("identity token layer", () => {
  it("fails closed when no signing key is configured", async () => {
    expect(issuingEnabled()).toBe(false);
    await expect(issueToken({ kind: "user", subject: "u1", ttlSeconds: 60 })).rejects.toThrow();
    // verify also refuses with no keys
    const v = await verifyToken("anything");
    expect(v.ok).toBe(false);
  });

  it("round-trips a user token and exposes the key in the JWKS", async () => {
    await configureSigner();
    const token = await issueToken({ kind: "user", subject: "user-123", scopes: ["propose"], ttlSeconds: 60 });
    const res = await verifyToken(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.kind).toBe("user");
      expect(res.claims.sub).toBe("user-123");
      expect(res.claims.iss).toBe(ISSUER);
      expect(res.claims.jti).toBeTruthy();
      expect(res.claims.scopes).toEqual(["propose"]);
    }
    const jwks = await getPublicJwks();
    expect(jwks.keys.length).toBe(1);
    expect(jwks.keys[0].d).toBeUndefined(); // no private material published
    expect(jwks.keys[0].kid).toBeTruthy();
  });

  it("binds an agent token to its bot_id", async () => {
    await configureSigner();
    const token = await issueToken({ kind: "agent", subject: "user-9", botId: "bot-uuid", ttlSeconds: 60 });
    const res = await verifyToken(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.kind).toBe("agent");
      expect(res.claims.bot_id).toBe("bot-uuid");
    }
  });

  it("rejects an expired token", async () => {
    await configureSigner();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await issueToken({ kind: "user", subject: "u", ttlSeconds: 60, now: past });
    const res = await verifyToken(token);
    expect(res.ok).toBe(false);
  });

  it("rejects alg=none (unsigned) forgery", async () => {
    await configureSigner();
    // Craft an unsigned JWT with the right claims.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: ISSUER, sub: "attacker", kind: "service",
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString("base64url");
    const forged = `${header}.${payload}.`;
    const res = await verifyToken(forged);
    expect(res.ok).toBe(false);
  });

  it("rejects a token signed by a DIFFERENT key (unknown kid / bad signature)", async () => {
    await configureSigner();
    // A token signed by an attacker's own Ed25519 key, with a kid we don't know.
    const attackerJwk = await freshEd25519PrivateJwk();
    const attackerKey = await importJWK({ ...attackerJwk, alg: IDENTITY_ALG }, IDENTITY_ALG);
    const kid = await calculateJwkThumbprint(attackerJwk);
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ kind: "service" })
      .setProtectedHeader({ alg: IDENTITY_ALG, kid, typ: "JWT" })
      .setIssuer(ISSUER).setSubject("attacker").setIssuedAt(now).setExpirationTime(now + 3600).setJti("x")
      .sign(attackerKey);
    const res = await verifyToken(forged);
    expect(res.ok).toBe(false);
  });

  it("rejects a token from the wrong issuer", async () => {
    await configureSigner();
    const { signer } = await (async () => {
      // Re-issue with a bad iss by hand-signing with our key.
      return { signer: null };
    })();
    void signer;
    const jwk = JSON.parse(process.env.KAX_IDENTITY_PRIVATE_JWK!) as JWK;
    const key = await importJWK({ ...jwk, alg: IDENTITY_ALG }, IDENTITY_ALG);
    const kid = jwk.kid || (await calculateJwkThumbprint(jwk));
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ kind: "user" })
      .setProtectedHeader({ alg: IDENTITY_ALG, kid, typ: "JWT" })
      .setIssuer("https://evil.example").setSubject("u").setIssuedAt(now).setExpirationTime(now + 60).setJti("y")
      .sign(key);
    const res = await verifyToken(token);
    expect(res.ok).toBe(false);
  });

  it("still verifies a token from a retired key kept in KAX_IDENTITY_PUBLIC_JWKS (rotation overlap)", async () => {
    // Old key signs a token; then we rotate: a NEW signer is configured and the
    // old PUBLIC key is retained in the JWKS. The old token must still verify.
    const oldJwk = await freshEd25519PrivateJwk();
    process.env.KAX_IDENTITY_PRIVATE_JWK = JSON.stringify(oldJwk);
    _resetKeyCache();
    const oldToken = await issueToken({ kind: "user", subject: "u", ttlSeconds: 300 });

    const oldPubJwk = await (async () => {
      const { d: _d, ...pub } = oldJwk as JWK & { d?: string };
      const kid = oldJwk.kid || (await calculateJwkThumbprint(oldJwk));
      return { ...pub, kid, alg: IDENTITY_ALG, use: "sig" };
    })();

    const newJwk = await freshEd25519PrivateJwk();
    process.env.KAX_IDENTITY_PRIVATE_JWK = JSON.stringify(newJwk);
    process.env.KAX_IDENTITY_PUBLIC_JWKS = JSON.stringify([oldPubJwk]);
    _resetKeyCache();

    const res = await verifyToken(oldToken);
    expect(res.ok).toBe(true);
    const jwks = await getPublicJwks();
    expect(jwks.keys.length).toBe(2); // new signer + retired public key
  });
});
