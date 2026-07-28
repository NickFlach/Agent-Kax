/**
 * siweDomain.test.ts — the SIWE domain must never be attacker-controlled (#29).
 *
 * `/auth/wallet/nonce` built the SIWE message domain from
 * `x-forwarded-host ?? host`. Both are request headers, so an attacker could
 * ask for a nonce as `evil.example`, receive a canonical server-issued and
 * server-PERSISTED message naming that domain, phish the victim's signature
 * over it, and post that signature to `/auth/wallet/verify` — which
 * deliberately verifies against the stored payload — to mint a real KAX
 * session.
 *
 * Pure by design: no database, no express. These assertions are about which
 * inputs are allowed to influence a security boundary.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_KAX_PUBLIC_URL,
  allowedSiweDomains,
  configuredSiweDomain,
  resolveSiweDomain,
} from "./siweDomain";

const CONFIGURED = "kax.ninja-portal.com";

describe("siweDomain (#29)", () => {
  describe("the request can never introduce a domain", () => {
    it("ignores a forged Host when no allowlist is configured", () => {
      const env = { KAX_PUBLIC_URL: `https://${CONFIGURED}` } as NodeJS.ProcessEnv;
      expect(resolveSiweDomain("evil.example", env)).toBe(CONFIGURED);
    });

    it("ignores a forged X-Forwarded-Host", () => {
      const env = { KAX_PUBLIC_URL: `https://${CONFIGURED}` } as NodeJS.ProcessEnv;
      expect(resolveSiweDomain("attacker.test", env)).toBe(CONFIGURED);
    });

    it("ignores a host that is merely a lookalike of an allowed one", () => {
      const env = {
        KAX_PUBLIC_URL: `https://${CONFIGURED}`,
        KAX_ALLOWED_SIWE_DOMAINS: CONFIGURED,
      } as NodeJS.ProcessEnv;
      // Suffix/prefix tricks must not pass — membership is exact, not substring.
      expect(resolveSiweDomain("kax.ninja-portal.com.evil.example", env)).toBe(CONFIGURED);
      expect(resolveSiweDomain("evilkax.ninja-portal.com", env)).toBe(CONFIGURED);
      expect(resolveSiweDomain("not-kax.ninja-portal.com", env)).toBe(CONFIGURED);
    });

    it("ignores an array-valued header (proxies can send more than one)", () => {
      const env = { KAX_PUBLIC_URL: `https://${CONFIGURED}` } as NodeJS.ProcessEnv;
      expect(resolveSiweDomain(["evil.example", CONFIGURED], env)).toBe(CONFIGURED);
    });

    it("ignores a host smuggled in with a scheme, path or userinfo", () => {
      const env = {
        KAX_PUBLIC_URL: `https://${CONFIGURED}`,
        KAX_ALLOWED_SIWE_DOMAINS: CONFIGURED,
      } as NodeJS.ProcessEnv;
      expect(resolveSiweDomain("https://evil.example/kax.ninja-portal.com", env)).toBe(CONFIGURED);
      expect(resolveSiweDomain(`${CONFIGURED}@evil.example`, env)).toBe(CONFIGURED);
    });
  });

  describe("legitimate multi-domain deployments", () => {
    it("honours a host that is explicitly allowlisted", () => {
      const env = {
        KAX_PUBLIC_URL: `https://${CONFIGURED}`,
        KAX_ALLOWED_SIWE_DOMAINS: `${CONFIGURED},kax.example.org`,
      } as NodeJS.ProcessEnv;
      expect(resolveSiweDomain("kax.example.org", env)).toBe("kax.example.org");
    });

    it("matches the allowlist case-insensitively and ignores whitespace", () => {
      const env = {
        KAX_PUBLIC_URL: `https://${CONFIGURED}`,
        KAX_ALLOWED_SIWE_DOMAINS: ` KAX.Example.ORG , ${CONFIGURED} `,
      } as NodeJS.ProcessEnv;
      expect(resolveSiweDomain("kax.example.org", env)).toBe("kax.example.org");
    });

    it("falls back to the configured domain when the host is not allowlisted", () => {
      const env = {
        KAX_PUBLIC_URL: `https://${CONFIGURED}`,
        KAX_ALLOWED_SIWE_DOMAINS: "kax.example.org",
      } as NodeJS.ProcessEnv;
      expect(resolveSiweDomain("evil.example", env)).toBe(CONFIGURED);
    });
  });

  describe("configuration handling", () => {
    it("uses KAX_PUBLIC_URL, stripped to a bare host", () => {
      expect(configuredSiweDomain({ KAX_PUBLIC_URL: "https://kax.example.org/" } as NodeJS.ProcessEnv))
        .toBe("kax.example.org");
    });

    it("falls back to the same default as auth-spacechild", () => {
      expect(configuredSiweDomain({} as NodeJS.ProcessEnv))
        .toBe(DEFAULT_KAX_PUBLIC_URL.replace("https://", ""));
    });

    it("treats a blank KAX_PUBLIC_URL as unset rather than an empty domain", () => {
      expect(configuredSiweDomain({ KAX_PUBLIC_URL: "   " } as NodeJS.ProcessEnv))
        .toBe(DEFAULT_KAX_PUBLIC_URL.replace("https://", ""));
    });

    it("treats an absent or blank allowlist as no allowlist", () => {
      expect(allowedSiweDomains({} as NodeJS.ProcessEnv)).toEqual([]);
      expect(allowedSiweDomains({ KAX_ALLOWED_SIWE_DOMAINS: "  " } as NodeJS.ProcessEnv)).toEqual([]);
    });

    it("never returns an empty domain, whatever the environment", () => {
      for (const env of [
        {},
        { KAX_PUBLIC_URL: "" },
        { KAX_PUBLIC_URL: "https://" },
        { KAX_ALLOWED_SIWE_DOMAINS: "," },
      ] as NodeJS.ProcessEnv[]) {
        expect(resolveSiweDomain(undefined, env)).toBeTruthy();
      }
    });
  });
});
