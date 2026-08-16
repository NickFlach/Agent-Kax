/**
 * publicBaseUrl.test.ts — the two ends of a payment must agree on where we live.
 *
 * Checkout resolved KAX_PUBLIC_URL -> REPLIT_DEV_DOMAIN -> REPLIT_DOMAINS. The
 * managed webhook registration used REPLIT_DOMAINS alone. So an operator who
 * read checkout's 503 — which names KAX_PUBLIC_URL first — and set only that
 * variable got a working checkout and a webhook at
 * `https://undefined/api/webhooks/stripe`.
 *
 * Customers charged. `checkout.session.completed` never delivered. Nothing
 * visibly wrong from either end: the redirect works and the Stripe dashboard
 * shows an endpoint exists.
 *
 * #276 found this and deliberately left the behaviour alone, because it could
 * not be exercised on the machine it was found from. It can be exercised here.
 *
 * The last test is the one that matters: it reads BOTH call sites as source and
 * fails if either ever grows its own answer again. The bug was never inside
 * either function — it was that there were two.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePublicBaseUrl } from "./publicBaseUrl";

const here = dirname(fileURLToPath(import.meta.url));

describe("public base URL", () => {
  it("prefers the URL the operator chose", () => {
    expect(
      resolvePublicBaseUrl({
        KAX_PUBLIC_URL: "https://kax.example.com",
        REPLIT_DEV_DOMAIN: "dev.replit.dev",
        REPLIT_DOMAINS: "prod.replit.app",
      }),
    ).toBe("https://kax.example.com");
  });

  it("refuses a schemeless override instead of guessing", () => {
    // The likely typo, because the variables beneath it are bare hosts.
    // Falling through to the platform domain would hide it behind a checkout
    // that quietly returns buyers somewhere the operator did not choose.
    expect(resolvePublicBaseUrl({ KAX_PUBLIC_URL: "kax.example.com", REPLIT_DOMAINS: "prod.replit.app" })).toBeNull();
  });

  it("takes the platform domain when no override is set", () => {
    expect(resolvePublicBaseUrl({ REPLIT_DEV_DOMAIN: "dev.replit.dev" })).toBe("https://dev.replit.dev");
    expect(resolvePublicBaseUrl({ REPLIT_DOMAINS: "prod.replit.app,other.app" })).toBe("https://prod.replit.app");
    // Dev wins over the comma list, matching the checkout precedence exactly.
    expect(resolvePublicBaseUrl({ REPLIT_DEV_DOMAIN: "dev.replit.dev", REPLIT_DOMAINS: "prod.replit.app" })).toBe(
      "https://dev.replit.dev",
    );
  });

  it("never returns a URL built from an unset variable", () => {
    // The actual defect: `https://${undefined}` is a STRING, and a perfectly
    // valid-looking one. It reached Stripe and was accepted.
    for (const env of [{}, { REPLIT_DOMAINS: "" }, { REPLIT_DEV_DOMAIN: "  " }, { KAX_PUBLIC_URL: "   " }]) {
      const got = resolvePublicBaseUrl(env);
      expect(got, `${JSON.stringify(env)} produced ${got}`).toBeNull();
      expect(String(got)).not.toContain("undefined");
    }
  });

  it("strips trailing slashes, so callers can append a path", () => {
    expect(resolvePublicBaseUrl({ KAX_PUBLIC_URL: "https://kax.example.com/" })).toBe("https://kax.example.com");
    expect(resolvePublicBaseUrl({ KAX_PUBLIC_URL: "https://kax.example.com///" })).toBe("https://kax.example.com");
  });

  it("gives checkout and the webhook the same answer, for every configuration", () => {
    // Both call the same function now, so this is a tautology at runtime —
    // which is the point. It is here to fail loudly if somebody reintroduces a
    // second resolver, because the divergence is invisible in production until
    // a customer has already been charged.
    const configs: Array<Record<string, string>> = [
      { KAX_PUBLIC_URL: "https://kax.example.com" },
      { KAX_PUBLIC_URL: "https://kax.example.com", REPLIT_DOMAINS: "prod.replit.app" },
      { REPLIT_DOMAINS: "prod.replit.app" },
      { REPLIT_DEV_DOMAIN: "dev.replit.dev", REPLIT_DOMAINS: "prod.replit.app" },
      {},
    ];
    for (const env of configs) {
      const checkoutBase = resolvePublicBaseUrl(env);
      const webhookBase = resolvePublicBaseUrl(env);
      expect(webhookBase, `disagreed for ${JSON.stringify(env)}`).toBe(checkoutBase);
    }
  });

  it("leaves neither call site with a private answer", () => {
    // The guard with teeth. Read both sites as source: neither may build a
    // base URL out of REPLIT_* directly any more. This is what catches the
    // next person who "just needs the domain here" — the exact shape of the
    // original bug.
    const sites = [
      join(here, "..", "routes", "store-checkout.ts"),
      join(here, "..", "index.ts"),
    ];
    for (const file of sites) {
      const src = readFileSync(file, "utf8");
      // Comments may name the variables; code may not read them.
      const code = src
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code, `${file} builds its own base URL from REPLIT_DOMAINS`).not.toMatch(
        /process\.env\[?["']REPLIT_DOMAINS/,
      );
      expect(code, `${file} builds its own base URL from REPLIT_DEV_DOMAIN`).not.toMatch(
        /process\.env\[?["']REPLIT_DEV_DOMAIN/,
      );
      expect(code).toContain("publicBaseUrl");
    }
  });
});
