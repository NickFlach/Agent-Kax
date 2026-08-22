/**
 * replayCursorPerType.test.ts — startup replay must track a cursor per event
 * type (#67).
 *
 * `replayMissedEventsOnStartup()` iterates every registered event type but
 * shared one `lastEventUuid`, declared outside the loop and advanced AND
 * persisted per event. So by the time the loop reached the second type, the
 * cursor already sat at wherever the first type's stream ended — backlog for
 * later types (`dm.received`, `proposal.created`) was skipped, and because the
 * skip was persisted, restarting never recovered it.
 *
 * Note what does NOT fix this: making the cursor a per-type local while still
 * persisting one global value. The stored uuid then ends up belonging to
 * whichever type ran last, and the next startup re-skips the others. Per-event
 * persistence can't simply be deferred either — it is what stops a crash
 * mid-replay from reprocessing everything. Hence a stored cursor per type.
 *
 * Source-level: this repo's DB-backed suite talks to a real database, which
 * must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const JOB = fs.readFileSync(path.join(__dirname, "harvesterJob.ts"), "utf8");
const CLIENT = fs.readFileSync(path.join(__dirname, "partnerClient.ts"), "utf8");
const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "lib", "db", "src", "schema", "partner.ts"), "utf8");
const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "lib", "db", "migrations");

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

/** The replay function body. */
function replayBody(): string {
  const src = code(JOB);
  const start = src.indexOf("export async function replayMissedEventsOnStartup");
  expect(start, "replay function not found").toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + 10);
  return src.slice(start, next > start ? next : undefined);
}

const BODY = replayBody();

describe("per-type replay cursor (#67)", () => {
  describe("storage", () => {
    it("the schema carries a per-type cursor map", () => {
      expect(SCHEMA).toContain('eventCursors: jsonb("event_cursors")');
      expect(SCHEMA).toContain("Record<string, string>");
    });

    it("keeps lastEventUuid, which /admin and /dashboard display", () => {
      // Removing it would break those surfaces; it stays as the
      // most-recently-processed marker.
      expect(SCHEMA).toContain('lastEventUuid: text("last_event_uuid")');
    });

    it("ships an additive, idempotent migration", () => {
      const file = fs.readdirSync(MIGRATIONS).find((f) => f.includes("event_cursors"));
      expect(file, "no migration for the new column").toBeTruthy();
      const sql = fs.readFileSync(path.join(MIGRATIONS, file!), "utf8");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS event_cursors jsonb");
      // A nullable add with no backfill and no rewrite of existing data.
      expect(sql).not.toContain("NOT NULL");
      expect(sql).not.toContain("DROP");
      expect(sql).not.toContain("UPDATE ");
    });
  });

  describe("the replay loop", () => {
    it("constructs the cursor per type, inside the loop", () => {
      const loopAt = BODY.indexOf("for (const eventType of eventTypes)");
      const declAt = BODY.indexOf("new ReplayCursor(");
      expect(loopAt).toBeGreaterThanOrEqual(0);
      expect(declAt).toBeGreaterThanOrEqual(0);
      expect(
        declAt > loopAt,
        "the cursor must be per type — one shared across types carries one " +
        "type's position into the next, which is the whole bug",
      ).toBe(true);
    });

    it("seeds each type from its own stored position", () => {
      expect(BODY).toContain("savedCursors[eventType]");
    });

    it("falls back to the old global cursor for a type with no position", () => {
      // Otherwise the first run after deploy replays every type from zero.
      expect(BODY).toContain("legacyCursor");
      expect(BODY).toContain("state?.lastEventUuid");
    });

    it("persists progress against the type it belongs to", () => {
      // Persistence now lives in ReplayCursor, which is always constructed with
      // the eventType — so every advance it makes is type-scoped. The loop
      // hands it the type once and holds no raw recordEventCursor of its own.
      expect(BODY).toContain("new ReplayCursor(savedCursors[eventType] ?? legacyCursor, eventType)");
      expect(BODY).not.toContain("recordEventCursor(");
      // The writer itself binds the jsonb path per type (verified below).
    });

    it("no longer reports a single conflated final cursor", () => {
      expect(BODY).toContain("finalCursors");
      expect(BODY).not.toContain("finalCursor:");
    });
  });

  describe("the cursor is owned by one writer, not scattered guards (#418)", () => {
    // The first #418 fix used site-local `deferred` guards, and the sibling
    // admin replay loop forgot one entirely — the review's finding. The
    // deferral behaviour is now proven directly in replayCursor.test.ts; here
    // we only pin that BOTH loops route every advance through ReplayCursor and
    // hold no raw recordEventCursor of their own, so a new persist site cannot
    // silently reintroduce the skip.
    it("the startup loop drives ReplayCursor and keeps no raw cursor write", () => {
      expect(BODY).toContain("new ReplayCursor(");
      expect(BODY).toContain("rc.onDeferred()");
      expect(BODY).toContain("rc.onPageBoundary(");
      expect(BODY).not.toContain("recordEventCursor(");
    });

    it("the sibling admin replay loop uses the same owner, not a bare lastUuid write", () => {
      const ADMIN = fs.readFileSync(path.join(__dirname, "..", "routes", "admin.ts"), "utf8");
      expect(ADMIN).toContain("new ReplayCursor(");
      expect(ADMIN).not.toContain("recordEventCursor(lastUuid)");
    });
  });

  describe("the writer", () => {
    const fn = CLIENT.slice(
      CLIENT.indexOf("export async function recordEventCursor"),
      CLIENT.indexOf("export async function recordWebhookReceived"),
    );

    it("updates only the given type's key, preserving the rest", () => {
      // jsonb_set on a coalesced object — a read-modify-write in JS would let
      // two writers clobber each other's types.
      expect(fn).toContain("jsonb_set(");
      expect(fn).toContain("coalesce(");
    });

    it("binds the jsonb path as a parameter, never string-built SQL", () => {
      expect(fn).toContain("ARRAY[${eventType}]::text[]");
      expect(fn).not.toContain("sql.raw");
    });

    it("still records lastEventUuid for the display surfaces", () => {
      expect(fn).toContain("lastEventUuid: eventUuid");
    });

    it("tolerates being called without a type", () => {
      // recordWebhookReceived and any older caller pass a uuid only; they must
      // not write a null key into the map.
      expect(fn).toContain("eventType?: string");
      expect(fn).toContain("...(eventType");
    });
  });
});
