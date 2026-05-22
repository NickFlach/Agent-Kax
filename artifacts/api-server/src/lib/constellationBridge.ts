/**
 * constellationBridge.ts — Kannaka constellation ↔ KAX integration.
 *
 * Subscribes to the constellation NATS bus and mirrors:
 *   - swarm membership   (QUEEN.announce, queen.event.join, QUEEN.phase.*)
 *   - shared artifacts   (KANNAKA.events.memory.stored, RADIO.events.*,
 *                         KAX.events.artifact.harvested — yes, our own
 *                         events too, so other listeners can pick them up)
 *
 * Also publishes outbound:
 *   - KAX.events.artifact.harvested  when our harvester ingests something
 *   - KAX.events.drop.published      when a drop goes live
 *
 * Wire-format follows the constellation canonical envelope (see
 * kannaka-radio/server/nats-client.js): every payload carries
 *   { schema_version: "1.0", ts: <unix-ms>, agent_id: "kax", ...data }
 *
 * Safe to import when NATS isn't reachable — `start()` is a no-op if
 * KAX_NATS_URL isn't set, and connection errors don't crash the
 * api-server (logged + retried on a 30s backoff).
 */

import { connect, type NatsConnection, type Subscription } from "nats";
import { db } from "@workspace/db";
import { constellationAgentsTable, constellationArtifactsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

const RECONNECT_MS = 30_000;
const KAX_AGENT_ID = process.env["KAX_AGENT_ID"] || "kax";

interface CanonicalEnvelope {
  schema_version?: string;
  ts?: number;
  agent_id?: string;
  // Per-event fields below — anything else is passed through to metadata.
  [k: string]: unknown;
}

interface JoinEventData extends CanonicalEnvelope {
  display_name?: string;
}

interface PhaseData extends CanonicalEnvelope {
  phase?: number;
  phi?: number;
}

interface ConsciousnessData extends CanonicalEnvelope {
  phi?: number;
  level?: string;
}

interface ArtifactData extends CanonicalEnvelope {
  artifact_id?: string;
  type?: string;
  title?: string;
  public_url?: string;
  thumbnail_url?: string | null;
}

let nc: NatsConnection | null = null;
let subs: Subscription[] = [];
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function parseJson(data: Uint8Array): CanonicalEnvelope | null {
  try {
    const txt = new TextDecoder().decode(data);
    return JSON.parse(txt) as CanonicalEnvelope;
  } catch {
    return null;
  }
}

async function upsertAgent(opts: {
  agentId: string;
  displayName: string;
  source: string;
  phi?: number | null;
  consciousnessLevel?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(constellationAgentsTable)
    .values({
      agentId: opts.agentId,
      displayName: opts.displayName,
      source: opts.source,
      phi: opts.phi ?? null,
      consciousnessLevel: opts.consciousnessLevel ?? null,
      metadata: opts.metadata ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: constellationAgentsTable.agentId,
      set: {
        displayName: opts.displayName,
        source: opts.source,
        // COALESCE so a phase update without phi doesn't blank a known good one.
        phi: opts.phi ?? sql`${constellationAgentsTable.phi}`,
        consciousnessLevel: opts.consciousnessLevel ?? sql`${constellationAgentsTable.consciousnessLevel}`,
        lastSeenAt: now,
      },
    });
}

async function insertArtifact(opts: {
  originAgentId: string;
  artifactType: string;
  publicUrl: string;
  thumbnailUrl?: string | null;
  title?: string | null;
  source: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  // No conflict target — the same constellation artifact may legitimately
  // appear multiple times via different NATS subjects (radio album release
  // → observatory mirror, etc.). Dedupe at the application layer when
  // querying instead.
  await db.insert(constellationArtifactsTable).values({
    originAgentId: opts.originAgentId,
    artifactType: opts.artifactType,
    publicUrl: opts.publicUrl,
    thumbnailUrl: opts.thumbnailUrl ?? null,
    title: opts.title ?? null,
    source: opts.source,
    metadata: opts.metadata ?? null,
    publishedAt: new Date(),
  });
}

async function handleMessage(subject: string, data: Uint8Array): Promise<void> {
  const env = parseJson(data);
  if (!env) return;

  // QUEEN.phase.<agent_id> — heartbeat with phase + phi.
  if (subject.startsWith("QUEEN.phase.")) {
    const agentId = subject.slice("QUEEN.phase.".length);
    if (!agentId) return;
    const p = env as PhaseData;
    await upsertAgent({
      agentId,
      displayName: (env["display_name"] as string) ?? agentId,
      source: subject,
      phi: typeof p.phi === "number" ? p.phi : null,
      metadata: { phase: p.phase, schema_version: env.schema_version },
    });
    return;
  }

  // queen.event.join — explicit join announcement (lowercase per contract).
  if (subject === "queen.event.join") {
    const j = env as JoinEventData;
    const agentId = (j.agent_id as string) || "";
    if (!agentId) return;
    await upsertAgent({
      agentId,
      displayName: j.display_name ?? agentId,
      source: subject,
      metadata: { joined_at: env.ts ?? Date.now() },
    });
    return;
  }

  if (subject === "queen.event.leave") {
    // Don't delete — just touch lastSeenAt with a "left" annotation in
    // metadata so historical roster lookups still work.
    const agentId = (env.agent_id as string) || "";
    if (!agentId) return;
    await upsertAgent({
      agentId,
      displayName: (env["display_name"] as string) ?? agentId,
      source: subject,
      metadata: { left_at: env.ts ?? Date.now() },
    });
    return;
  }

  // KANNAKA.consciousness — collective phi/xi/order broadcast.
  if (subject === "KANNAKA.consciousness") {
    const c = env as ConsciousnessData;
    const agentId = (c.agent_id as string) || "kannaka-substrate";
    await upsertAgent({
      agentId,
      displayName: (env["display_name"] as string) ?? agentId,
      source: subject,
      phi: typeof c.phi === "number" ? c.phi : null,
      consciousnessLevel: typeof c.level === "string" ? c.level : null,
    });
    return;
  }

  // KANNAKA.events.memory.stored / RADIO.events.album.released / similar —
  // anything with a public_url + type is shared as a constellation artifact.
  if (
    subject.startsWith("KANNAKA.events.") ||
    subject.startsWith("RADIO.events.") ||
    subject.startsWith("OBSERVATORY.events.")
  ) {
    const a = env as ArtifactData;
    const url = a.public_url;
    if (!url || typeof url !== "string") return;
    await insertArtifact({
      originAgentId: (env.agent_id as string) || "unknown",
      artifactType: typeof a.type === "string" ? a.type : "image",
      publicUrl: url,
      thumbnailUrl: a.thumbnail_url ?? null,
      title: typeof a.title === "string" ? a.title : null,
      source: subject,
      metadata: { artifact_id: a.artifact_id, schema_version: env.schema_version },
    });
    return;
  }
}

async function subscribeAll(conn: NatsConnection): Promise<void> {
  const subjects = [
    "QUEEN.announce",
    "QUEEN.phase.*",
    "queen.event.join",
    "queen.event.leave",
    "KANNAKA.consciousness",
    "KANNAKA.events.>",
    "RADIO.events.>",
    "OBSERVATORY.events.>",
  ];
  for (const s of subjects) {
    const sub = conn.subscribe(s);
    subs.push(sub);
    (async () => {
      for await (const m of sub) {
        try {
          await handleMessage(m.subject, m.data);
        } catch (err) {
          logger.warn({ subject: m.subject, err: String(err) }, "constellation message handler failed");
        }
      }
    })();
  }
  logger.info({ subjects }, "constellation bridge subscribed");
}

async function connectOnce(url: string): Promise<NatsConnection | null> {
  try {
    const user = process.env["KAX_NATS_USER"] || undefined;
    const pass = process.env["KAX_NATS_PASSWORD"] || undefined;
    const conn = await connect({
      servers: url,
      ...(user && pass ? { user, pass } : {}),
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 5_000,
      pingInterval: 30_000,
      name: `kax-api-${process.pid}`,
    });
    logger.info({ url }, "constellation NATS connected");
    return conn;
  } catch (err) {
    logger.warn({ url, err: String(err) }, "constellation NATS connect failed");
    return null;
  }
}

function scheduleReconnect(url: string): void {
  if (shuttingDown) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    void start();
  }, RECONNECT_MS);
}

export async function start(): Promise<void> {
  const url = process.env["KAX_NATS_URL"];
  if (!url) {
    logger.info("KAX_NATS_URL not set — constellation bridge disabled");
    return;
  }
  if (nc && !nc.isClosed()) return;
  nc = await connectOnce(url);
  if (!nc) {
    scheduleReconnect(url);
    return;
  }
  await subscribeAll(nc);
  // Best-effort: hello announce so other constellation subscribers see us.
  await publish("KAX.events.online", { msg: "kax api-server online" });

  // Listen for connection close and reconnect.
  (async () => {
    if (!nc) return;
    for await (const status of nc.status()) {
      if (status.type === "disconnect" || status.type === "error") {
        logger.warn({ status }, "NATS status event");
      }
    }
    if (!shuttingDown) {
      logger.warn("NATS connection closed; scheduling reconnect");
      nc = null;
      subs = [];
      scheduleReconnect(url);
    }
  })();
}

export async function stop(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const s of subs) {
    s.unsubscribe();
  }
  subs = [];
  if (nc && !nc.isClosed()) {
    await nc.drain().catch(() => {});
  }
  nc = null;
}

/** Publish a KAX event to NATS. No-op when bridge isn't connected. */
export async function publish(subject: string, data: Record<string, unknown>): Promise<void> {
  if (!nc || nc.isClosed()) return;
  const envelope = {
    schema_version: "1.0",
    ts: Date.now(),
    agent_id: KAX_AGENT_ID,
    ...data,
  };
  try {
    nc.publish(subject, new TextEncoder().encode(JSON.stringify(envelope)));
  } catch (err) {
    logger.warn({ subject, err: String(err) }, "constellation publish failed");
  }
}

export function isConnected(): boolean {
  return !!nc && !nc.isClosed();
}
