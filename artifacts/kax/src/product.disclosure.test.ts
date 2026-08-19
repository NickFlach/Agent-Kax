/**
 * product.disclosure.test.ts — #260's disclosure and no-stock-photo ACs, in
 * this package's established idiom (source-level property tests; there is no
 * jsdom/testing-library here, and App.routes.test.ts sets the precedent —
 * the property that must hold is asserted against the source that produces
 * the DOM, stated as such in the PR).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, "pages", "product.tsx"), "utf8");
const APP = readFileSync(join(here, "App.tsx"), "utf8");

describe("the product page (#260)", () => {
  it("renders the SERVER's disclosure string, unconditionally wired into the DOM", () => {
    // The disclosure arrives from the API and is rendered verbatim — the
    // page must reference the field and place it in JSX, not compose its own
    // copy of the sentence (one source, no drift).
    expect(PAGE).toMatch(/disclosure\s*&&|{disclosure}/);
    expect(PAGE).toMatch(/data-testid="ai-disclosure"/);
    // And no client-side re-composition of the sentence:
    expect(PAGE).not.toMatch(/AI-generated on OpenBotCity/);
  });

  it("renders the four-line attribution block", () => {
    for (const line of ["Sold by", "Created by", "Powered by", "Fulfilled by"]) {
      expect(PAGE).toContain(line);
    }
  });

  it("uses ArtifactCover and has NO stock-photo fallback path", () => {
    expect(PAGE).toMatch(/<ArtifactCover/);
    // The regression this guards: an onError fallback to a random stock
    // photo. Neither the mechanism nor the host may appear.
    expect(PAGE).not.toMatch(/picsum|placeholder\.com|unsplash|loremflickr/i);
    expect(PAGE).not.toMatch(/<img\s/); // the cover component owns all images
  });

  it("the route exists in App.tsx", () => {
    expect(APP).toMatch(/path="\/products\/:id"/);
    expect(APP).toMatch(/<ProductPage/);
  });
});
