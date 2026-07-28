/**
 * frontendBasePathUrls.test.ts — the SPA must build API and share URLs under
 * its configured base path (#110).
 *
 * `artifacts/kax/vite.config.ts` refuses to boot without `BASE_PATH` and
 * exports it as `base`, so KAX explicitly supports being mounted somewhere
 * other than `/`. The router and the player honour it; the auth hook and the
 * share-link builders did not — they hardcoded `fetch("/api/...")` and
 * `` `${window.location.origin}/api/share/...` ``.
 *
 * On a subpath deployment those escape the app base and hit the site root, so
 * wallet auth and session refresh break and share links point nowhere.
 *
 * Checked from here because the frontend package has no test runner of its own;
 * this suite already reads frontend sources for the same reason (see
 * nftMetadataPublicShape.test.ts). Adding vitest to the SPA is worth doing, but
 * not inside a bug fix — it would put a brand-new suite in the path of every
 * unrelated PR.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const KAX = path.join(__dirname, "..", "..", "..", "kax", "src");
const read = (...p: string[]) => fs.readFileSync(path.join(KAX, ...p), "utf8");

const URLS = read("lib", "urls.ts");
const AUTH = read("hooks", "use-auth.ts");
const PAGES = ["artifacts-list.tsx", "agent-storefront-drop.tsx", "artifact-detail.tsx"];

/** Source with comment-only lines dropped, so prose never satisfies a check. */
function code(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("frontend base-path URLs (#110)", () => {
  describe("the premise", () => {
    it("the SPA genuinely supports a non-root base", () => {
      // If BASE_PATH ever stops being required/exported, this whole class of
      // bug disappears and these assertions should be revisited.
      const vite = fs.readFileSync(path.join(KAX, "..", "vite.config.ts"), "utf8");
      expect(vite).toContain("BASE_PATH");
      expect(vite).toContain("base:");
    });
  });

  describe("the helper", () => {
    it("derives the base from BASE_URL and strips only trailing slashes", () => {
      expect(URLS).toContain("import.meta.env.BASE_URL");
      expect(URLS).toContain('.replace(/\\/+$/, "")');
    });

    it("does not collapse slashes globally, which would corrupt https://", () => {
      // player-context.tsx can do that safely because it only builds a path.
      // absoluteUrl prepends an origin, so the same expression here would turn
      // https://host into https:/host.
      expect(code(URLS)).not.toContain('.replace(/\\/+/g, "/")');
    });

    it("exposes both a relative and an absolute builder", () => {
      expect(URLS).toContain("export function appUrl");
      expect(URLS).toContain("export function absoluteUrl");
      expect(URLS).toContain("window.location.origin");
    });
  });

  describe("the auth hook", () => {
    it("routes every API call through the helper", () => {
      const bare = code(AUTH)
        .split("\n")
        .filter((l) => /fetch\(\s*["'`]\//.test(l));
      expect(bare, `auth call(s) bypassing the app base: ${bare.join(" | ")}`).toEqual([]);
    });

    it("no /api path reaches fetch without passing through the base", () => {
      // A literal "/api/..." is fine when it is an ARGUMENT to postJson, which
      // applies appUrl itself (asserted below) — the seven wallet/email calls
      // are all of that form. What must not exist is a literal path handed
      // straight to fetch, or to some other helper that does not re-base it.
      const literals = code(AUTH)
        .split("\n")
        .filter((l) => /["'`]\/api\//.test(l))
        .filter((l) => !l.includes("appUrl(") && !l.includes("postJson("));
      expect(literals, `un-based /api paths: ${literals.join(" | ")}`).toEqual([]);
    });

    it("sends the POST helper through the base too", () => {
      // postJson funnels seven of the nine calls, so it is the one that
      // matters most.
      expect(AUTH).toContain("return fetch(appUrl(path), {");
    });

    it("keeps navigation targets base-aware", () => {
      // These already worked via a local BASE constant, which the helper
      // replaced — they must not regress to bare paths.
      expect(AUTH).toContain('appUrl("/login")');
      expect(AUTH).toContain('appUrl("/")');
    });

    it("dropped the duplicate local base constant", () => {
      expect(code(AUTH)).not.toContain("const BASE = ");
    });
  });

  describe("share links", () => {
    for (const page of PAGES) {
      it(`${page} builds share URLs through absoluteUrl`, () => {
        const src = code(read("pages", page));
        expect(src).toContain("absoluteUrl(");
        const raw = src.split("\n").filter((l) => l.includes("window.location.origin"));
        expect(raw, `raw origin URL(s) in ${page}: ${raw.join(" | ")}`).toEqual([]);
      });
    }

    it("no page anywhere in the SPA still concatenates origin by hand", () => {
      // The issue listed two pages; artifact-detail.tsx had the same bug and
      // was not mentioned, so this sweeps the whole tree rather than trusting
      // the report's list.
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.(tsx?|ts)$/.test(e.name)) {
            for (const line of code(fs.readFileSync(full, "utf8")).split("\n")) {
              if (line.includes("window.location.origin") && !full.endsWith("urls.ts")) {
                offenders.push(`${e.name}: ${line.trim()}`);
              }
            }
          }
        }
      };
      walk(KAX);
      expect(offenders, `unbased origin URLs: ${offenders.join(" | ")}`).toEqual([]);
    });
  });
});
