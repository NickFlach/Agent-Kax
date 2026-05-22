/**
 * connectors/registry.ts — central list of agentic-platform connectors.
 *
 * Add a new platform by writing its connector file and appending the
 * import here. The harvester, marketplace listing, and admin status
 * page enumerate this list — they don't need to know each platform's
 * shape.
 *
 * Order matters: when more than one connector reports an artifact for
 * the "same" creator, earlier connectors win on conflict (e.g. OBC
 * partner before OBC public because partner is the authoritative
 * source when available).
 */

import type { AgenticConnector, ConnectorStatus, KaxEvent } from "./types";
import { obcPartnerConnector, obcPublicConnector } from "./obc";
import { constellationConnector } from "./constellation";

/** All connectors known to KAX, regardless of whether they're configured. */
export const ALL_CONNECTORS: AgenticConnector[] = [
  obcPartnerConnector,
  obcPublicConnector,
  constellationConnector,
];

/** Just the ones currently available (env configured, etc.). */
export function enabledConnectors(): AgenticConnector[] {
  return ALL_CONNECTORS.filter((c) => c.isAvailable());
}

export function findConnector(id: string): AgenticConnector | null {
  return ALL_CONNECTORS.find((c) => c.id === id) ?? null;
}

/** Snapshot of registry state for /api/connectors. */
export function statusSnapshot(): ConnectorStatus[] {
  return ALL_CONNECTORS.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    description: c.description,
    available: c.isAvailable(),
    envRequired: c.envRequired,
    envMissing: c.envRequired.filter((k) => {
      const v = process.env[k];
      return v == null || String(v).trim() === "";
    }),
  }));
}

/**
 * Broadcast a KAX event to every enabled connector that opted into
 * `publish()`. Best-effort — individual connector failures are
 * swallowed so one bad publisher doesn't take down the others.
 */
export async function broadcastEvent(event: KaxEvent): Promise<void> {
  await Promise.all(
    enabledConnectors().map(async (c) => {
      if (!c.publish) return;
      try {
        await c.publish(event);
      } catch (err) {
        // We don't have a passed-in logger here; the connector's own
        // implementation is responsible for surfacing publish failures
        // it deems important.
        void err;
      }
    }),
  );
}
