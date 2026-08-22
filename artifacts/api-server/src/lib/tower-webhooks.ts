import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { and, eq, lt, lte, or } from "drizzle-orm";
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
 * EGRESS-GUARDED, TOCTOU-CLOSED: a tenant-registered URL passes
 * `validateWebhookUrl` at registration, and delivery goes through
 * `https.request` with a `lookup` that vets EVERY resolved address and hands
 * the socket ONLY vetted ones — so the address the guard checks and the
 * address the socket dials are the same resolution, with no rebinding window
 * between them. https.request also does not follow redirects, so a receiver
 * answering `302 → http://169.254.169.254/` is just a non-2xx failure, never
 * a followed hop. An IP-literal host (which Node connects without calling
 * `lookup`) is vetted inline before the request. Together these remove the
 * whole SSRF class the earlier fetch-based path only narrowed.
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
/** Delivered/failed rows older than this are pruned — the outbox is a
 *  delivery queue, not a permanent archive (roomChatHistory keeps the
 *  readable tail). */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A DNS lookup that resolves once, vets every returned address as public
 * unicast, and returns ONLY vetted addresses to the connecting socket. This
 * is the TOCTOU close: the vetting resolution and the connecting resolution
 * are one and the same, so a hostile resolver cannot answer "public" to a
 * pre-check and "private" to the connect. Node skips `lookup` entirely for an
 * IP-literal host, so those are vetted inline in `deliverSigned` instead.
 */
function vettingLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  const opts = (typeof options === "object" && options !== null ? options : {}) as Record<string, unknown>;
  dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as unknown as LookupAddress[];
    if (!list.length) return callback(new Error(`webhook host ${hostname} did not resolve`), "");
    for (const a of list) {
      if (!ipIsPublicUnicast(a.address)) {
        return callback(new Error(`webhook host ${hostname} resolves to non-public address ${a.address}`), "");
      }
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

export interface DeliveryResult {
  status: number;
}

/**
 * POST a signed body to a receiver over a DNS-pinned https connection. The
 * seam the sweeper calls — injectable so tests can drive delivery outcomes
 * without a socket. The default (below) is the real, egress-guarded poster.
 */
export type Deliverer = (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<DeliveryResult>;

const deliverSigned: Deliverer = (url, headers, body, timeoutMs) =>
  new Promise<DeliveryResult>((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("invalid webhook url"));
      return;
    }
    if (u.protocol !== "https:") { reject(new Error("webhook url must be https")); return; }
    // Node does NOT call `lookup` for an IP-literal host, so vet it here.
    const bareHost = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(bareHost) && !ipIsPublicUnicast(bareHost)) {
      reject(new Error(`webhook host ${bareHost} is not public address space`));
      return;
    }
    const req = httpsRequest(
      url,
      // `lookup` is overloaded (all:true → array); vettingLookup honors both
      // forms, but LookupFunction only describes the single-address shape, so
      // cast at the boundary.
      { method: "POST", headers, timeout: timeoutMs, lookup: vettingLookup as unknown as LookupFunction },
      (res) => {
        res.resume(); // drain; the status is all we need
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("delivery timeout")));
    req.end(body);
  });

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
export async function deliverPendingTowerEvents(now: Date = new Date(), deliver: Deliverer = deliverSigned): Promise<DeliverReport> {
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
      // The egress guard lives INSIDE deliverSigned's DNS-pinned lookup now:
      // one resolution, vetted, used for the socket — no rebinding window, and
      // no redirects followed. See deliverSigned.
      const res = await deliver(
        floor.webhookUrl,
        {
          "content-type": "application/json",
          "user-agent": "KAXTower/1.0 (+https://kax.ninja-portal.com/tower)",
          "x-tower-event": ev.kind,
          "x-tower-delivery": String(ev.id),
          "x-tower-signature": signBody(floor.webhookSecret, body),
        },
        body,
        DELIVER_TIMEOUT_MS,
      );
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

/**
 * Drop terminal (delivered/failed) events past the retention window. The
 * outbox is a delivery queue, not an archive — without this, every chat line
 * on every leased floor is a permanent row and the table grows without bound.
 * Pending rows are never pruned: an undelivered event is still owed.
 */
export async function pruneTowerEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_MS);
  const gone = await db
    .delete(towerFloorEventsTable)
    .where(and(
      or(eq(towerFloorEventsTable.state, "delivered"), eq(towerFloorEventsTable.state, "failed")),
      lt(towerFloorEventsTable.createdAt, cutoff),
    ))
    .returning({ id: towerFloorEventsTable.id });
  return gone.length;
}

let timer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function startTowerWebhookScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    deliverPendingTowerEvents().catch((e) => logger.warn({ err: e }, "tower webhook sweep failed"));
  }, 30_000);
  timer.unref();
  // Prune hourly — cheap, and terminal rows have no delivery urgency.
  pruneTimer = setInterval(() => {
    pruneTowerEvents().catch((e) => logger.warn({ err: e }, "tower event prune failed"));
  }, 60 * 60 * 1000);
  pruneTimer.unref();
  logger.info("tower webhook delivery scheduler armed (30s deliver, 1h prune)");
}
