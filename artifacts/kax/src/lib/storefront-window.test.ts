/**
 * storefront-window.test.ts — the street must not call a full shop empty.
 *
 * `claimed` means "has a non-system owner". It says nothing about whether the
 * store holds work. The street asked only that question and printed FOR LEASE
 * on the answer, so it advertised bodies of work as vacant premises.
 *
 * Measured against the live directory on 2026-08-16: 302 storefronts, 278
 * unclaimed, and every single one of those 278 holds work. Median 24 artifacts.
 * The largest, `rex`, holds 1534 — repaired from a split identity earlier the
 * same day, then described by its own shopfront as available and empty.
 *
 * These are the real numbers, used as fixtures on purpose: a threshold checked
 * only against invented values is a threshold nobody has calibrated.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THIN_STOREFRONT_ARTIFACTS, storefrontWindowCard } from "./storefront-window";

const here = dirname(fileURLToPath(import.meta.url));

describe("storefront window card", () => {
  it("does not call a store with work empty", () => {
    // The bug, in one line. rex holds 1534 artifacts and is unclaimed.
    expect(storefrontWindowCard({ claimed: false, artifacts: 1534 })).toBe("unclaimed-with-works");
    // …and the issue's own example.
    expect(storefrontWindowCard({ claimed: false, artifacts: 217 })).toBe("unclaimed-with-works");
  });

  it("still advertises a genuinely empty one", () => {
    // The card has a job. A store with nothing in it is fairly called vacant,
    // and removing FOR LEASE entirely would lose the only signal that a
    // storefront can be claimed at all.
    expect(storefrontWindowCard({ claimed: false, artifacts: 0 })).toBe("for-lease");
  });

  it("treats one or two pieces as thin rather than as a body of work", () => {
    // Deliberate, and the judgement most likely to be argued with: below the
    // threshold a storefront is a harvest artefact. Live, 48 unclaimed stores
    // hold exactly one piece.
    expect(storefrontWindowCard({ claimed: false, artifacts: 1 })).toBe("for-lease");
    expect(storefrontWindowCard({ claimed: false, artifacts: THIN_STOREFRONT_ARTIFACTS - 1 })).toBe("for-lease");
    expect(storefrontWindowCard({ claimed: false, artifacts: THIN_STOREFRONT_ARTIFACTS })).toBe(
      "unclaimed-with-works",
    );
  });

  it("puts no card on a claimed store or a civic building", () => {
    expect(storefrontWindowCard({ claimed: true, artifacts: 0 })).toBe("none");
    expect(storefrontWindowCard({ claimed: true, artifacts: 900 })).toBe("none");
    // Constellation venues are the arcade, the bank, the trading floor. They
    // are not premises anybody leases, whatever their artifact count says.
    expect(storefrontWindowCard({ claimed: false, source: "constellation", artifacts: 0 })).toBe("none");
  });

  it("does not let a missing count promote a store", () => {
    // An absent number must read as thin, not as work. The opposite would put
    // "works by …" on a store that has none, which is the same lie backwards.
    expect(storefrontWindowCard({ claimed: false, artifacts: NaN })).toBe("for-lease");
    expect(storefrontWindowCard({ claimed: false, artifacts: -5 })).toBe("for-lease");
    expect(storefrontWindowCard({ claimed: false, artifacts: undefined as unknown as number })).toBe("for-lease");
  });

  it("leaves the street with no predicate of its own", () => {
    // The bug was a predicate inline in a 1300-line scene file, where nothing
    // could reach it. If it grows back there, this fails.
    const scene = readFileSync(join(here, "..", "pages", "marketplace-3d.tsx"), "utf8");
    const code = scene
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).toContain("storefrontWindowCard");
    expect(code, "the street decides for itself again").not.toMatch(/!isClaimed\s*&&\s*!isConstellation/);
  });

  it("keeps both cards' labels inside a Suspense boundary", () => {
    // Same convention as everywhere else in the app: drei <Text> suspends on
    // the font, and an unguarded one holds back its siblings. Two cards now,
    // so two boundaries.
    const scene = readFileSync(join(here, "..", "pages", "marketplace-3d.tsx"), "utf8");
    const offenders: number[] = [];
    for (const m of scene.matchAll(/<Text[\s>]/g)) {
      const before = scene.slice(0, m.index!);
      const opened = (before.match(/<Suspense/g) ?? []).length;
      const closed = (before.match(/<\/Suspense>/g) ?? []).length;
      if (opened <= closed) offenders.push(before.split(/\r?\n/).length);
    }
    expect(offenders, "<Text> rendered with no Suspense above it").toEqual([]);
  });
});
