/**
 * webhookReplayCursor.test.ts — an unhandled webhook must not move the replay
 * cursor past itself (#169).
 *
 * #164 fixed one half of this: an event with no registered handler is no longer
 * written to `processed_events`, so dedupe cannot block its recovery. That is
 * necessary but not sufficient. The webhook route separately called
 * `recordWebhookReceived(eventUuid)`, which set `partner_sync_state.last_event_uuid`
 * unconditionally — and `replayMissedEventsOnStartup` falls back to that column
 * for any event type with no per-type cursor recorded yet.
 *
 * A newly registered event type is exactly that case. So the sequence that
 * matters ran like this: OBC starts sending a new type, the webhooks arrive
 * unhandled, the cursor advances past them, the handler ships, and replay for
 * the new type starts from a position already beyond the backlog it exists to
 * collect. The events were recoverable in principle and unreachable in practice.
 *
 * Behavioural rather than source-level: the whole defect is an interaction
 * between the route, the dispatcher and a persisted column, and the assertion
 * worth making is what that column holds afterwards. This is a DB-backed suite,
 * so it runs in CI against the workflow's Postgres service.
 *
 * `partner_sync_state` is a singleton row shared with the rest of the suite, so
 * the original is captured and restored around these tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import crypto from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db } from "@workspace/db";
import { partnerSyncStateTable, processedEventsTable } from "@workspace/db/schema";
import { testLogger } from "../test-helpers";

const SECRET = "kax-test-webhook-secret";
process.env["OBC_WEBHOOK_SECRET"] = SECRET;

const { PARTNER_SYNC_ID, getSyncState } = await import("../lib/partnerClient");
const { registerEventHandler } = await import("../lib/eventDispatcher");
const webhooksRouter = (await import("./webhooks")).default;

/** Prefix so this file's processed_events rows can be cleaned up precisely. */
const PREFIX = "kaxtest-cursor-";
/** The cursor position every test starts from; assertions compare against it. */
const BASELINE = `${PREFIX}baseline-event`;
/** An event type this service has a handler for. */
const HANDLED_TYPE = "kax.test.handled";
/** A type nothing is registered for — the "OBC just introduced this" case. */
const UNKNOWN_TYPE = "obc.some.future.event";

function buildApp(): Express {
  const app = express();
  // The router installs its own raw() body parser, so nothing may consume the
  // stream first — the HMAC is computed over the exact bytes sent.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { log: typeof testLogger }).log = testLogger;
    next();
  });
  app.use(webhooksRouter);
  return app;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

function eventId(): string {
  return `${PREFIX}${crypto.randomUUID()}`;
}

async function post(app: Express, envelope: Record<string, unknown>) {
  const body = JSON.stringify(envelope);
  return request(app)
    .post("/webhooks/openbotcity")
    .set("Content-Type", "application/json")
    .set("x-openbotcity-signature", sign(body))
    .send(body);
}

async function cursor(): Promise<string | null> {
  const state = await getSyncState();
  return state?.lastEventUuid ?? null;
}

async function setCursor(uuid: string): Promise<void> {
  await getSyncState(); // ensures the singleton row exists
  await db
    .update(partnerSyncStateTable)
    .set({ lastEventUuid: uuid, webhookSubscribed: "inactive", lastWebhookAt: null })
    .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID));
}

describe("webhook replay cursor (#169)", () => {
  let app: Express;
  let original: { lastEventUuid: string | null; webhookSubscribed: string } | null = null;

  beforeAll(async () => {
    registerEventHandler(HANDLED_TYPE, async () => {
      // Applying the event is not what is under test; returning normally is
      // what makes the dispatcher report "handled".
    });
    const state = await getSyncState();
    original = state
      ? { lastEventUuid: state.lastEventUuid, webhookSubscribed: state.webhookSubscribed }
      : null;
  });

  beforeEach(async () => {
    app = buildApp();
    await setCursor(BASELINE);
  });

  afterAll(async () => {
    await db.delete(processedEventsTable).where(like(processedEventsTable.eventUuid, `${PREFIX}%`));
    if (original) {
      await db
        .update(partnerSyncStateTable)
        .set({
          lastEventUuid: original.lastEventUuid,
          webhookSubscribed: original.webhookSubscribed,
        })
        .where(eq(partnerSyncStateTable.id, PARTNER_SYNC_ID));
    }
  });

  describe("an event with no registered handler", () => {
    it("does not advance the replay cursor past itself", async () => {
      const uuid = eventId();
      const res = await post(app, { event_uuid: uuid, event_type: UNKNOWN_TYPE, data: {} });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("unhandled");
      expect(
        await cursor(),
        "advancing lastEventUuid past an unhandled event skips it for the " +
          "handler that ships later — replay falls back to this column for any " +
          "event type with no per-type cursor",
      ).toBe(BASELINE);
    });

    it("leaves it out of processed_events as well", async () => {
      // The other half of recoverability (#164). Asserted here because the two
      // only work together: an event the cursor has skipped is never offered to
      // the deduper, and an event the deduper rejects is never applied.
      const uuid = eventId();
      await post(app, { event_uuid: uuid, event_type: UNKNOWN_TYPE, data: {} });

      const rows = await db
        .select()
        .from(processedEventsTable)
        .where(eq(processedEventsTable.eventUuid, uuid));
      expect(rows).toHaveLength(0);
    });

    it("still records the delivery as live", async () => {
      // The liveness fields must NOT become conditional: the delivery really
      // did arrive and authenticate, and the dashboard's webhook health is read
      // from these. Losing them would trade a data-loss bug for a monitoring
      // blind spot.
      const uuid = eventId();
      await post(app, { event_uuid: uuid, event_type: UNKNOWN_TYPE, data: {} });

      const state = await getSyncState();
      expect(state?.webhookSubscribed).toBe("active");
      expect(state?.lastWebhookAt).not.toBeNull();
    });
  });

  describe("an event that was actually applied", () => {
    it("does advance the replay cursor", async () => {
      // The other direction. If the cursor stopped advancing altogether, every
      // restart would replay the entire retained event history — a worse bug
      // than the one being fixed, and one that would hide behind the same
      // "unhandled events are safe now" assertion.
      const uuid = eventId();
      const res = await post(app, { event_uuid: uuid, event_type: HANDLED_TYPE, data: {} });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("handled");
      expect(await cursor()).toBe(uuid);
    });

    it("records it in processed_events", async () => {
      const uuid = eventId();
      await post(app, { event_uuid: uuid, event_type: HANDLED_TYPE, data: {} });

      const rows = await db
        .select()
        .from(processedEventsTable)
        .where(eq(processedEventsTable.eventUuid, uuid));
      expect(rows).toHaveLength(1);
    });

    it("advances for a redelivery of an already-processed event", async () => {
      // "deduped" means the event is already in processed_events, so it was
      // applied on an earlier delivery and the cursor may safely pass it.
      const uuid = eventId();
      await post(app, { event_uuid: uuid, event_type: HANDLED_TYPE, data: {} });
      await setCursor(BASELINE);

      const res = await post(app, { event_uuid: uuid, event_type: HANDLED_TYPE, data: {} });
      expect(res.body.status).toBe("deduped");
      expect(await cursor()).toBe(uuid);
    });
  });

  describe("the recovery the fix exists to enable", () => {
    it("an unknown event stays reachable once its handler is registered", async () => {
      // The end-to-end property from the report: a webhook that arrives before
      // this service supports its type must still be replayable afterwards.
      // Both preconditions for that are: the cursor did not move past it, and
      // nothing recorded it as processed.
      const uuid = eventId();
      const lateType = "obc.late.handler.event";
      await post(app, { event_uuid: uuid, event_type: lateType, data: {} });

      expect(await cursor()).toBe(BASELINE);
      const before = await db
        .select()
        .from(processedEventsTable)
        .where(eq(processedEventsTable.eventUuid, uuid));
      expect(before).toHaveLength(0);

      // The handler ships. A redelivery (or a replay from the un-advanced
      // cursor) now applies it.
      registerEventHandler(lateType, async () => {});
      const res = await post(app, { event_uuid: uuid, event_type: lateType, data: {} });

      expect(res.body.status).toBe("handled");
      expect(await cursor()).toBe(uuid);
      const after = await db
        .select()
        .from(processedEventsTable)
        .where(eq(processedEventsTable.eventUuid, uuid));
      expect(after).toHaveLength(1);
    });
  });
});
