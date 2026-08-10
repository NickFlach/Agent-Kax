/**
 * unhandledEventRecoverable.test.ts — an event nobody handled must stay
 * recoverable (#164).
 *
 * `processed_events` is the dedupe gate for BOTH webhook redelivery and startup
 * replay. Writing a row there is therefore a permanent decision: it means "this
 * event is finished with". The no-handler branch used to write one anyway, so
 * an event type OBC introduced — or one that arrived before this service had
 * registered its handler — was consumed by a log line and could never be
 * recovered. Shipping the handler afterwards did not help, because replay
 * dedupes on exactly that table.
 *
 * The dispatcher already had the right precedent next door: `EventDeferredError`
 * leaves the row unwritten so a later replay re-offers the event (#103). The
 * unhandled case is the same shape — nothing applied it, so nothing should be
 * recorded.
 *
 * Source-level on purpose, matching `liveRoleChecks.test.ts` and
 * `publicRouteGating.test.ts`: `eventDispatcher.ts` imports the
 * `@workspace/db` singleton, which throws at import unless DATABASE_URL is set,
 * so asserting this behaviourally needs the real-database harness that must not
 * run from a dev machine. What regressed is which branch performs the write.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.join(__dirname, "eventDispatcher.ts"), "utf8");

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

const CODE = code(SRC);

/** The no-handler branch: from the `if (!handler)` test to its closing brace. */
function noHandlerBranch(): string {
  const start = CODE.indexOf("if (!handler) {");
  expect(start, "no-handler branch not found").toBeGreaterThanOrEqual(0);
  const end = CODE.indexOf('return { status: "unhandled"', start);
  expect(end, "unhandled return not found").toBeGreaterThan(start);
  return CODE.slice(start, end);
}

describe("unhandled partner events stay recoverable (#164)", () => {
  it("does not record an unhandled event as processed", () => {
    expect(
      noHandlerBranch().includes("processedEventsTable"),
      "writing processed_events here permanently consumes an event no handler " +
        "ever saw — replay dedupes on that table, so deploying the handler " +
        "later cannot recover it",
    ).toBe(false);
  });

  it("still reports the event as unhandled to the caller", () => {
    // The dispatcher must not silently swallow it either: the webhook route and
    // the replay loop both branch on this status.
    expect(CODE).toContain('return { status: "unhandled"');
  });

  it("still records events that a handler actually processed", () => {
    // Guards the other direction. If the insert were removed outright rather
    // than moved out of this branch, every event would be re-processed forever
    // and dedupe would be gone — a worse bug than the one being fixed.
    const handledInsert = CODE.slice(CODE.indexOf("await handler("));
    expect(handledInsert).toContain(".insert(processedEventsTable)");
    expect(handledInsert).toContain('return { status: "handled"');
  });

  it("keeps the dedupe pre-check that makes processed_events meaningful", () => {
    const preCheck = CODE.slice(0, CODE.indexOf("const handler = handlers.get"));
    expect(preCheck).toContain("processedEventsTable.eventUuid");
    expect(preCheck).toContain('status: "deduped"');
  });

  it("leaves the deferral path unrecorded for the same reason", () => {
    // #103's guarantee. Asserted here because both branches now rely on the
    // same rule — an event that nothing applied is never written down — and a
    // future edit that "tidies up" one should have to confront the other.
    const deferBranch = CODE.slice(
      CODE.indexOf("if (err instanceof EventDeferredError)"),
      CODE.indexOf('return {\nstatus: "deferred"') + 200,
    );
    expect(deferBranch).not.toContain(".insert(processedEventsTable)");
  });
});
