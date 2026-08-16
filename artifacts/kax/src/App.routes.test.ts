/**
 * App.routes.test.ts — a lazy route that renders outside Suspense is a blank
 * screen with a clean build.
 *
 * The 3D venues and the signed-in pages are now `React.lazy`, which cut the
 * initial bundle from 627 kB gzipped to 151 kB. It also introduced a failure
 * mode this repo had no way to catch: a lazy component rendered outside a
 * Suspense boundary throws at RUNTIME, on navigation, in the browser — the
 * typecheck passes, the build passes, and the page is white. There is no
 * frontend test runner here and no way to click through in CI, so the guard is
 * static: it reads the routing table and checks the shape of it.
 *
 * Deliberately parsing the source rather than rendering. Rendering wouold need
 * jsdom, a DOM, a router and a query client, and would still only cover the
 * routes somebody remembered to visit. What matters is a property that holds
 * for EVERY route, including the one added next month.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(here, "App.tsx"), "utf8");

/** Every `const X = lazy(() => import("path"))` in the routing table. */
function lazyDecls(): Array<{ name: string; path: string }> {
  return [...APP.matchAll(/const (\w+) = lazy\(\(\) => import\("([^"]+)"\)\)/g)].map((m) => ({
    name: m[1]!,
    path: m[2]!,
  }));
}

/** Is this character offset inside an open Suspense (or the Venue wrapper)? */
function insideBoundary(offset: number): boolean {
  const before = APP.slice(0, offset);
  const opened = (before.match(/<Suspense/g) ?? []).length + (before.match(/<Venue>/g) ?? []).length;
  const closed = (before.match(/<\/Suspense>/g) ?? []).length + (before.match(/<\/Venue>/g) ?? []).length;
  return opened > closed;
}

describe("routing table", () => {
  it("splits the heavy pages out of the initial bundle", () => {
    // If these ever go back to a static import the bundle silently doubles and
    // nothing fails — the app just gets slower for everybody who never walks
    // into a venue.
    const names = lazyDecls().map((d) => d.name);
    for (const venue of [
      "Marketplace3D",
      "Residences",
      "ArcadeHall",
      "BankHall",
      "FurnitureHall",
      "Cafe",
      "StoreInterior",
      "GsTradingFloor",
    ]) {
      expect(names, `${venue} is no longer code-split`).toContain(venue);
    }
    // The dashboard pulls recharts, which no logged-out visitor should pay for.
    expect(names).toContain("Dashboard");
  });

  it("renders every lazy route inside a Suspense boundary", () => {
    // The whole point. React throws on a lazy component with no boundary
    // above it, at navigation time, with a white page and a console message
    // nobody is watching.
    const offenders: string[] = [];
    for (const { name } of lazyDecls()) {
      for (const m of APP.matchAll(new RegExp(`<${name}\\s*/>`, "g"))) {
        if (!insideBoundary(m.index!)) {
          offenders.push(`${name} at line ${APP.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(offenders, "lazy routes rendered with no Suspense above them").toEqual([]);
  });

  it("points every lazy import at a file that exists", () => {
    // A typo here is a chunk that 404s on navigation. Vite resolves these at
    // build time, but only for paths it can see — this also covers the case
    // where somebody moves a page and updates the eager imports only.
    for (const { name, path } of lazyDecls()) {
      expect(path.startsWith("@/pages/"), `${name} imports from outside pages`).toBe(true);
      const file = resolve(here, path.replace("@/", "./"));
      const found = [".tsx", ".ts"].some((ext) => existsSync(file + ext));
      expect(found, `${name} imports ${path}, which is not a file`).toBe(true);
    }
  });

  it("keeps a lazy page from also being imported eagerly", () => {
    // A page that is both lazy AND statically imported lands in the initial
    // bundle anyway. The split still "works", the chunk still appears, and the
    // saving is zero — the most expensive kind of silent regression, because
    // every visible sign says it succeeded.
    for (const { name, path } of lazyDecls()) {
      const eager = new RegExp(`import\\s+${name}\\s+from\\s+"${path.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}"`);
      expect(eager.test(APP), `${name} is imported both lazily and eagerly`).toBe(false);
    }
  });
});
