/**
 * storefrontArtifactVisibility.test.ts — the standalone storefront artifact
 * view must resolve what the storefront's works listing renders (#114).
 *
 * `/storefront/by-agent/:slug/works` deliberately applies no drop or status
 * floor — "the storefront IS the agent's harvested body of work" — and
 * attributes by `agentId` OR `creatorBotId` (see `agentWorksWhere`).
 *
 * The detail route `/storefront/by-agent/:slug/artifacts/:id` did neither: it
 * matched on `agentId` alone and 404'd anything not sitting in a *published*
 * drop. The storefront therefore listed works whose own detail page 404'd —
 * every harvested piece never put in a drop, plus anything attributed only by
 * OBC creator identity.
 *
 * Aligning them exposes nothing new: the listing already returns these rows
 * publicly through the same `formatArtifact` payload. These assertions pin that
 * equivalence, so the two cannot silently drift apart again.
 *
 * Source-level on purpose: this repo's DB-backed suite talks to a real
 * database, which must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "routes", "agent-storefront.ts"), "utf8");

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

/** Body of a route handler, from its registration to the next one. */
function handler(registration: string): string {
  const src = code(SRC);
  const start = src.indexOf(registration);
  expect(start, `route not found: ${registration}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nrouter.", start + 1);
  return src.slice(start, next > start ? next : undefined);
}

const DETAIL = handler('router.get("/storefront/by-agent/:slug/artifacts/:id"');
const WORKS = handler('router.get("/storefront/by-agent/:slug/works"');

describe("standalone storefront artifact view (#114)", () => {
  describe("the premise: the works listing has no drop or status floor", () => {
    it("selects by the shared agentWorksWhere predicate", () => {
      expect(WORKS).toContain("agentWorksWhere(agent)");
    });

    it("agentWorksWhere attributes by creatorBotId as well as agentId", () => {
      const fn = code(SRC).slice(code(SRC).indexOf("function agentWorksWhere"));
      const body = fn.slice(0, fn.indexOf("\n}") + 2);
      expect(body).toContain("artifactsTable.agentId");
      expect(body).toContain("artifactsTable.creatorBotId");
    });

    it("the listing applies no drop gate of its own", () => {
      // If a floor is ever added to /works, the detail route should gain the
      // same one and this test's premise needs revisiting.
      expect(WORKS).not.toContain("dropsTable");
    });
  });

  describe("the detail route resolves the same rows", () => {
    it("uses the same agentWorksWhere predicate as the listing", () => {
      expect(
        DETAIL.includes("agentWorksWhere(agent)"),
        "the detail route must resolve by the same predicate the listing " +
        "renders, or the storefront links to pages that 404",
      ).toBe(true);
    });

    it("does not 404 an artifact merely for having no drop", () => {
      expect(
        DETAIL.includes("Artifact not published"),
        "an artifact outside a published drop is still part of the agent's " +
        "harvested body of work and is already listed publicly by /works",
      ).toBe(false);
    });

    it("no longer consults drop status at all", () => {
      expect(DETAIL).not.toContain("dropsTable");
      expect(DETAIL).not.toContain('status !== "published"');
    });

    it("still scopes the lookup to the requested agent", () => {
      // The fix must not turn this into a global artifact-by-id endpoint that
      // ignores the :slug in the path.
      expect(DETAIL).toContain("loadAgentBySlug(slug)");
      expect(DETAIL).toContain("Agent not found");
      expect(DETAIL).toContain("eq(artifactsTable.id, id)");
    });

    it("still 404s an artifact that is not this agent's", () => {
      expect(DETAIL).toContain("Artifact not found");
    });

    it("returns the same public shape as the listing", () => {
      // Same formatter both sides is what makes the alignment safe: the detail
      // view cannot expose a field the listing does not already publish.
      expect(DETAIL).toContain("formatArtifact(artifact)");
      expect(WORKS).toContain("formatArtifact");
    });
  });
});
