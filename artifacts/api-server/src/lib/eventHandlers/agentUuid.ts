/**
 * Finding the agent UUID in a partner payload.
 *
 * "Every payload carries the agent UUID as the join key" — which is the good
 * news; the open question is under which NAME. The three new events are
 * unseen from here, and the existing handlers already show the shape of the
 * problem: `matchCompleted` reads `match_uuid ?? uuid`, `dmReceived` reads
 * `dm_uuid ?? uuid`, each because the field name was learned rather than
 * specified.
 *
 * So this is liberal, ordered most-specific first, and it looks one level down
 * into the containers a payload might nest the agent in. It also validates the
 * SHAPE — a uuid, not any string — because the value becomes a database key, a
 * ledger account fragment and a residency principal, and a malformed one would
 * mint an agent row nobody can reach rather than fail.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Names checked at the top level and inside each container, in this order. */
export const AGENT_UUID_FIELDS = [
  "agent_uuid",
  "agentUuid",
  "bot_uuid",
  "botUuid",
  "bot_id",
  "botId",
  "obc_bot_id",
  "obcBotId",
  "agent_id",
  "agentId",
  "uuid",
  "id",
] as const;

/** Objects a payload might nest the agent inside. */
const CONTAINERS = ["agent", "bot", "data", "payload", "subject", "target", "verification"];

function pick(obj: Record<string, unknown>): string | null {
  for (const f of AGENT_UUID_FIELDS) {
    const v = obj[f];
    if (typeof v === "string" && UUID_RE.test(v.trim())) return v.trim().toLowerCase();
  }
  return null;
}

/** The agent uuid this payload is about, or null if none can be found. */
export function agentUuidOf(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const top = pick(obj);
  if (top) return top;
  for (const c of CONTAINERS) {
    const inner = obj[c];
    if (typeof inner === "string" && UUID_RE.test(inner.trim())) return inner.trim().toLowerCase();
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const hit = pick(inner as Record<string, unknown>);
      if (hit) return hit;
    }
  }
  return null;
}

/** A display name for a new agent, if the payload volunteered one. */
export function displayNameOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const names = [
    "display_name",
    "displayName",
    "name",
    "agent_name",
    "agentName",
    "bot_name",
    "botName",
    "handle",
    "username",
  ];
  const containers = [obj, obj["agent"], obj["bot"], obj["data"], obj["payload"]];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    for (const f of names) {
      const v = (c as Record<string, unknown>)[f];
      if (typeof v === "string" && v.trim() && v.trim().length <= 120) return v.trim();
    }
  }
  return null;
}

/** An avatar url, if one came along. Only http(s); never a data: blob. */
export function avatarUrlOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const fields = ["avatar_url", "avatarUrl", "image_url", "imageUrl", "avatar"];
  const containers = [obj, obj["agent"], obj["bot"], obj["data"], obj["payload"]];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    for (const f of fields) {
      const v = (c as Record<string, unknown>)[f];
      if (typeof v === "string" && /^https?:\/\//i.test(v.trim()) && v.length <= 2048) {
        return v.trim();
      }
    }
  }
  return null;
}

/** Why a verification was withdrawn, when the payload says. */
export function reasonOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const fields = [
    "reason",
    "revocation_reason",
    "revocationReason",
    "revoked_reason",
    "revokedReason",
    "cause",
    "detail",
    "details",
    "message",
    "note",
  ];
  const containers = [obj, obj["data"], obj["payload"], obj["verification"], obj["revocation"]];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    for (const f of fields) {
      const v = (c as Record<string, unknown>)[f];
      // Bounded: this is stored and displayed, and the column is varchar.
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
    }
  }
  return null;
}

/** Whoever OCC says owns the agent, as an opaque reference string. */
export function ownerRefOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const fields = [
    "owner_uuid",
    "ownerUuid",
    "owner_id",
    "ownerId",
    "owner",
    "human_uuid",
    "humanUuid",
    "verified_by",
    "verifiedBy",
    "owner_handle",
    "ownerHandle",
    "owner_email",
    "ownerEmail",
  ];
  const containers = [obj, obj["data"], obj["payload"], obj["verification"], obj["owner"]];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    for (const f of fields) {
      const v = (c as Record<string, unknown>)[f];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
    }
  }
  return null;
}
