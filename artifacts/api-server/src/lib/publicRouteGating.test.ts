/**
 * publicRouteGating.test.ts — the three unauthenticated read routes must stay
 * gated on publication (#161, #162, #163).
 *
 * `/artifacts/:id`, `/drops/:id` and `/storefront/featured` are all mounted
 * without `requireAuth`, deliberately: each serves both a public visitor and a
 * signed-in owner from one handler. That makes the publication gate the *only*
 * thing standing between an id-guesser and owner-scoped rows, and it is
 * invisible at the mount site — `routes/index.ts` looks identical for a guarded
 * and an unguarded handler.
 *
 * All three were reported as regressions in August against guards that landed
 * in `8b3370f` (2026-05-22) and had never been touched since. They had no test,
 * so confirming the state of the gate meant re-reading the routes by hand every
 * time. These assertions make that a one-command answer.
 *
 * Source-level on purpose, matching `liveRoleChecks.test.ts` and
 * `storefrontArtifactVisibility.test.ts`: the property that regressed is
 * *which predicate a handler applies*, and `lib/visibility.ts` imports the
 * `@workspace/db` singleton, which throws at import time unless DATABASE_URL is
 * set. A behavioural test would need the express + real-database harness that
 * the rest of the DB-backed suite uses, which must not run from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTES = path.join(__dirname, "..", "routes");

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

/** Body of a route handler in `file`, from its registration to the next one. */
function handler(file: string, registration: string): string {
  const src = code(fs.readFileSync(path.join(ROUTES, file), "utf8"));
  const start = src.indexOf(registration);
  expect(start, `route not found: ${registration}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nrouter.", start + 1);
  return src.slice(start, next > start ? next : undefined);
}

const ARTIFACT_DETAIL = handler("artifacts.ts", 'router.get("/artifacts/:id"');
const DROP_DETAIL = handler("drops.ts", 'router.get("/drops/:id"');
const FEATURED = handler("storefront.ts", 'router.get("/storefront/featured"');

describe("GET /artifacts/:id is gated on publication (#161)", () => {
  it("resolves the viewer with a live role read", () => {
    expect(ARTIFACT_DETAIL).toContain("getOptionalAuth(req)");
  });

  it("applies the shared visibility predicate to non-owners", () => {
    expect(
      ARTIFACT_DETAIL.includes("isArtifactPublic("),
      "without this the handler returns formatArtifact() for any id, leaking " +
        "ownerId / agentId / obcArtifactUuid / scoring state by enumeration",
    ).toBe(true);
  });

  it("404s rather than 403s when the artifact is not visible", () => {
    // Two distinct 404 exits: one for "no such row", one for "exists but not
    // yours and not published". Asserting the count matters — the missing-row
    // 404 survives even when the visibility gate is deleted, so a bare
    // toContain() here would pass against exactly the reported bug.
    const notFound = ARTIFACT_DETAIL.match(
      /res\.status\(404\)\.json\(\{ error: "Artifact not found" \}\)/g,
    );
    expect(notFound?.length, "expected both the missing-row and not-visible 404 exits").toBe(2);
    // A 403 would confirm the row exists, which is itself the leak.
    expect(ARTIFACT_DETAIL).not.toContain("res.status(403)");
  });

  it("only short-circuits the gate for the owner or an admin", () => {
    expect(ARTIFACT_DETAIL).toContain('auth.role === "admin" || artifact.ownerId === auth.id');
  });
});

describe("GET /drops/:id is gated on publication (#162)", () => {
  it("resolves the viewer with a live role read", () => {
    expect(DROP_DETAIL).toContain("getOptionalAuth(req)");
  });

  it("hides a non-published drop from everyone but its owner", () => {
    expect(
      DROP_DETAIL.includes('!isOwnerView && draft.status !== "published"'),
      "the drop list is auth-gated, so an ungated detail route is how draft " +
        "titles, prices and attached artifacts leak before release",
    ).toBe(true);
    expect(DROP_DETAIL).toContain('res.status(404).json({ error: "Drop not found" })');
  });

  it("applies the publishable-status floor to a public view's artifacts", () => {
    // A published drop must not become a back door to raw/scored rows: the
    // private drop-management route stamps status='dropped' on attach without
    // going through score -> narrate.
    expect(DROP_DETAIL).toContain("publicOnly: !isOwnerView");
  });

  it("inspects the drop's status before loading its artifacts", () => {
    const statusCheck = DROP_DETAIL.indexOf('draft.status !== "published"');
    const load = DROP_DETAIL.indexOf("getDropWithArtifacts(");
    expect(statusCheck).toBeGreaterThanOrEqual(0);
    expect(
      statusCheck < load,
      "the status gate must run before the artifacts are fetched",
    ).toBe(true);
  });
});

describe("GET /storefront/featured only surfaces published work (#163)", () => {
  it("constrains the featured query with the shared visibility predicate", () => {
    expect(
      FEATURED.includes("publicArtifactWhere()"),
      "filtering on kannakaScore alone returns scored-but-unpublished " +
        "artifacts, so internal inventory appears as a featured transmission",
    ).toBe(true);
  });

  it("does not select featured artifacts on score alone", () => {
    // Pins the exact shape that regressed: `.where(isNotNull(kannakaScore))`
    // with nothing else.
    expect(FEATURED).not.toMatch(/\.where\(\s*isNotNull\(artifactsTable\.kannakaScore\)\s*\)/);
  });

  it("keeps the neighbouring latestDrop publication-gated", () => {
    expect(FEATURED).toContain('eq(dropsTable.status, "published")');
    expect(FEATURED).toContain("isPublishableStatus(a.status)");
  });
});

describe("publicArtifactWhere() carries all three predicates", () => {
  // The route tests above assert the call site. This asserts the callee still
  // means what they assume — otherwise the gate could be emptied out in one
  // place while every call site still reads as guarded.
  const VISIBILITY = code(fs.readFileSync(path.join(__dirname, "visibility.ts"), "utf8"));
  const FN = (() => {
    const start = VISIBILITY.indexOf("export function publicArtifactWhere");
    expect(start, "publicArtifactWhere not found in visibility.ts").toBeGreaterThanOrEqual(0);
    const next = VISIBILITY.indexOf("\nexport ", start + 1);
    return VISIBILITY.slice(start, next > start ? next : undefined);
  })();

  it("requires the artifact to be attached to a drop", () => {
    expect(FN).toContain("dropId} IS NOT NULL");
  });

  it("requires that drop to be published", () => {
    expect(FN).toContain('eq(dropsTable.status, "published")');
    expect(FN).toContain("inArray(artifactsTable.dropId, publishedDropIds)");
  });

  it("requires the artifact's own status to be publishable", () => {
    expect(FN).toContain("PUBLISHABLE_STATUSES");
  });

  it("keeps the publishable set to narrated and dropped", () => {
    // Widening this set silently widens every public surface at once.
    expect(VISIBILITY).toContain('export const PUBLISHABLE_STATUSES = ["narrated", "dropped"] as const');
  });
});
