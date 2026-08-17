/**
 * venue-shell.test.ts — a Canvas with no height renders into a sliver.
 *
 * The 0xSCADA firm shipped with its scene squashed into the top quarter of the
 * screen. Its root element was `<div className="marketplace-3d-root">`, a class
 * that EXISTS NOWHERE — I imported `marketplace-3d.css` and invented a class
 * name that file never defined.
 *
 * Nothing could have caught it. Typecheck passes: it is a string. The build
 * passes: it is a string. Every test passed. Tailwind emits no warning for a
 * class it does not recognise, and CSS has no concept of a missing rule — the
 * div simply had no height, so the Canvas collapsed to its intrinsic size and
 * drew the room into a letterbox.
 *
 * The four working interiors all use the same shell and always did. This
 * asserts the fifth does too, and the sixth.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, "..", "pages");

/** Every page that mounts a 3D Canvas — i.e. every page that needs a height. */
function canvasPages(): Array<{ file: string; src: string }> {
  return readdirSync(pagesDir)
    .filter((f) => f.endsWith(".tsx"))
    .map((file) => ({ file, src: readFileSync(join(pagesDir, file), "utf8") }))
    .filter((p) => /<Canvas[\s>]/.test(p.src));
}

describe("venue shells", () => {
  it("finds the pages that mount a Canvas", () => {
    // If this ever returns nothing the rest of the file is vacuous — the exact
    // failure mode that let an empty loop pass for a real assertion earlier.
    const pages = canvasPages();
    expect(pages.length, "no Canvas pages found — has the layout changed?").toBeGreaterThan(3);
  });

  it("gives every Canvas page a root with a height", () => {
    // h-screen is what the Canvas fills. Without it the scene renders into
    // whatever intrinsic size it can find, which is a letterbox at the top of
    // the page — and looks like a broken camera rather than a missing class.
    const offenders: string[] = [];
    for (const { file, src } of canvasPages()) {
      // The root is the first className in the returned tree.
      const m = /return \(\s*\r?\n?\s*<div className="([^"]+)"/.exec(src);
      if (!m) {
        offenders.push(`${file}: no root <div className> found`);
        continue;
      }
      const cls = m[1]!;
      if (!/\bh-screen\b|\bh-\[100/.test(cls)) {
        offenders.push(`${file}: root has no height (${cls})`);
      }
    }
    expect(offenders, "Canvas pages whose root cannot give the scene a height").toEqual([]);
  });

  it("uses no class the stylesheets never define", () => {
    // The actual mistake: a bespoke class name imported from a stylesheet that
    // does not contain it. Tailwind utilities are generated, so only bespoke
    // names — the ones with a dash and no utility prefix — are checked here.
    const cssFiles = readdirSync(pagesDir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(pagesDir, f), "utf8"))
      .join("\n");
    const globalCss = (() => {
      try {
        return readFileSync(join(here, "..", "index.css"), "utf8");
      } catch {
        return "";
      }
    })();
    const allCss = cssFiles + "\n" + globalCss;

    const offenders: string[] = [];
    for (const { file, src } of canvasPages()) {
      const m = /return \(\s*\r?\n?\s*<div className="([^"]+)"/.exec(src);
      if (!m) continue;
      for (const cls of m[1]!.split(/\s+/)) {
        // Only bespoke, project-specific names. Utilities like `relative`,
        // `h-screen` and `bg-[#10161b]` are Tailwind's business.
        if (!/^(marketplace|kax3d|city)[a-z0-9-]*$/i.test(cls)) continue;
        if (!allCss.includes(cls)) offenders.push(`${file}: "${cls}" is defined in no stylesheet`);
      }
    }
    expect(offenders, "bespoke classes that no stylesheet defines").toEqual([]);
  });
});
