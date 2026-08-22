import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq, lte } from "drizzle-orm";
import { db } from "@workspace/db";
import { towerFloorsTable, towerFloorEventsTable } from "@workspace/db/schema";
import { logger } from "./logger";
import { backoffMs, ipIsPublicUnicast, signBody, type TowerEventKind } from "./tower-webhooks-core";

export { newWebhookSecret, validateWebhookUrl, signBody, backoffMs, ipIsPublicUnicast, TOWER_EVENT_KINDS, type TowerEventKind } from "./tower-webhooks-core";

/**
 * The tower's signed webhook feed (KAX-ADR-0005 Phase 1) — the delivery half.
 * The pure half (signature, URL gate, address-space test, backoff) lives in
 * tower-webhooks-core.ts, where tests can pin it without a database.
 *
 * Tenants are outside the process, so the city comes to them — but ONLY to
 * them, and only signed. Two invariants carried here:
 *
 * EGRESS-GUARDED: a tenant-registered URL passes `validateWebhookUrl` at
 * registration and `assertPublicHost` again before EVERY delivery — https
 * only, no userinfo, and the resolved address must be public unicast space.
 * Without the second check the delivery job is an SSRF proxy: register
 * `https://169.254.169.254/` (or a hostname that resolves there) and read
 * the cloud metadata service with our egress. Known residual: a hostile DNS
 * server could pass the pre-delivery resolution and rebind before the fetch
 * connects (TOCTOU). Closing that fully means dialing the resolved IP with a
 * pinned Host header; recorded as follow-up debt rather than silently
 * accepted — the check here still removes the whole static-address class.
 *
 * SIGNED, DURABLY: an event is an outbox row first (enqueue), delivered by
 * the sweeper with exponential backoff and a terminal state — the same
 * durable-outbox discipline the settlement path uses. Every delivery carries
 * `X-Tower-Signature: sha256=<hmac>` over the exact body, keyed by the
 * floor's stored secret, so a tenant can refuse anything the city did not
 * say. A dark floor's deliveries HOLD (stay pending, clock stopped): dark
 * refuses service in both directions without losing the tenant's events.
 */

const MAX_ATTEMPTS = 8;
const DELIVER_BATCH = 20;
const DELIVER_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Resolve the hostname and refuse a delivery into non-public space. */
async function assertPublicHost(url: string): Promise<void> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!ipIsPublicUnicast(host)) throw new Error(`webhook host ${host} is not public address space`);
    return;
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error(`webhook host ${host} did not resolve`);
  for (const a of addrs) {
    if (!ipIsPublicUnicast(a.address)) {
      throw new Error(`webhook host ${host} resolves to non-public address ${a.address}`);
    }
  }
}

// ── The outbox ──────────────────────────────────────────────

/**
 * Record an event for a floor. Best-effort by design (like chat history):
 * a webhook outage must never break the action that caused the event.
 * Config-present decides, NOT floor status: lease.ended is enqueued around
 * the vacancy flip (a race either way), and the webhook config survives
 * lease end precisely so the departed tenant hears it. Floors that never
 * registered a receiver get no rows — events with no destination only pile up.
 */
export async function enqueueTowerEvent(floorNo: number, kind: TowerEventKind, payload: Record<string, unknown>): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    if (body.length > MAX_PAYLOAD_BYTES) return;
    const [floor] = await db.select().from(towerFloorsTable).where(eq(towerFloorsTable.floorNo, floorNo)).limit(1);
    if (!floor || !floor.webhookUrl || !floor.webhookSecret) return;
    await db.insert(towerFloorEventsTable).values({ floorNo, kind, payload });
  } catch (e) {
    logger.warn({ err: e, floorNo, kind }, "tower event enqueue failed (best-effort)");
  }
}

export interface DeliverReport {
  scanned: number;
  delivered: number;
  retried: number;
  failed: number;
  held: number;
}

/**
 * Deliver due pending events. Idempotent to re-runs (each delivery carries
 * its event id; a tenant that saw id 41 twice can drop the second), safe as
 * an interval job, and per-event isolated: one tenant's dead receiver only
 * costs its own rows their attempts.
 */
export async function deliverPendingTowerEvents(now: Date = new Date(), fetchFn: typeof fetch = fetch): Promise<DeliverReport> {
  const report: DeliverReport = { scanned: 0, delivered: 0, retried: 0, failed: 0, held: 0 };
  const due = await db
    .select()
    .from(towerFloorEventsTable)
    .where(and(eq(towerFloorEventsTable.state, "pending"), lte(towerFloorEventsTable.nextAttemptAt, now)))
    .orderBy(towerFloorEventsTable.id)
    .limit(DELIVER_BATCH);

  for (const ev of due) {
    report.scanned++;
    const [floor] = await db.select().from(towerFloorsTable).where(eq(towerFloorsTable.floorNo, ev.floorNo)).limit(1);
    // Dark HOLDS (service refused in both directions, events kept). A floor
    // with no webhook config has no receiver — cleared by the tenant, or by
    // the next GRANT (which is where a departed tenant's config dies, so a
    // successor can never inherit the feed). Vacant-with-config still
    // delivers: those are the departed tenant's own tail events.
    if (!floor || floor.status === "dark") { report.held++; continue; }
    if (!floor.webhookUrl || !floor.webhookSecret) {
      await db.update(towerFloorEventsTable)
        .set({ state: "failed", lastError: "no receiver: webhook not configured" })
        .where(eq(towerFloorEventsTable.id, ev.id));
      report.failed++;
      continue;
    }

    const body = JSON.stringify({
      id: ev.id,
      kind: ev.kind,
      floorNo: ev.floorNo,
      at: ev.createdAt.toISOString(),
      payload: ev.payload,
    });
    try {
      await assertPublicHost(floor.webhookUrl);
      const res = await fetchFn(floor.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "KAXTower/1.0 (+https://kax.ninja-portal.com/tower)",
          "x-tower-event": ev.kind,
          "x-tower-delivery": String(ev.id),
          "x-tower-signature": signBody(floor.webhookSecret, body),
        },
        body,
        signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) {
        await db.update(towerFloorEventsTable)
          .set({ state: "delivered", deliveredAt: new Date(), lastError: null })
          .where(eq(towerFloorEventsTable.id, ev.id));
        report.delivered++;
        continue;
      }
      throw new Error(`receiver answered ${res.status}`);
    } catch (e) {
      const attempts = ev.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      await db.update(towerFloorEventsTable)
        .set({
          attempts,
          state: terminal ? "failed" : "pending",
          lastError: String((e as Error)?.message ?? e).slice(0, 300),
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
        })
        .where(eq(towerFloorEventsTable.id, ev.id));
      if (terminal) report.failed++; else report.retried++;
    }
  }
  return report;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startTowerWebhookScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    deliverPendingTowerEvents().catch((e) => logger.warn({ err: e }, "tower webhook sweep failed"));
  }, 30_000);
  timer.unref();
  logger.info("tower webhook delivery scheduler armed (30s)");
}
