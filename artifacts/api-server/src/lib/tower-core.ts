/**
 * tower-core.ts — the pure half of Ghost Signals Tower (KAX-ADR-0005).
 *
 * Everything here is arithmetic and validation with no I/O, in the
 * joinery-core mould: the invariants that matter — a rent posting is
 * deterministic and idempotent, a prorated first month never bills more than
 * a full one, a panel can never smuggle markup or an off-allowlist asset in
 * front of a visitor's browser — live in one place where a test can hold
 * them still.
 *
 * The storey list and room-id format are NOT defined here: lib/rooms.ts is
 * their one definition (`TOWER_FLOOR_NOS`, `towerRoom`, `parseTowerRoom`),
 * and this module answers to it.
 */

import { TOWER_FLOOR_NOS } from "./rooms";

export function isLeasableTowerFloor(floorNo: number): boolean {
  return (TOWER_FLOOR_NOS as readonly number[]).includes(floorNo);
}

// ── Rent ────────────────────────────────────────────────────

/**
 * `lease:tower:<floor>:<YYYY-MM>` — one posting per floor per UTC calendar
 * month, no matter how many times the billing job runs. The same
 * deterministic-txId discipline as `grant:signup:<principal>` and the joinery
 * sale ids: idempotency is the ledger's, not the scheduler's.
 */
export function leaseTxId(floorNo: number, periodKey: string): string {
  return `lease:tower:${floorNo}:${periodKey}`;
}

/** The UTC calendar month a date falls in, as the billing period key. */
export function periodKeyUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function daysInPeriodUTC(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export class InvalidRent extends Error {
  readonly code = "invalid_rent";
}

/**
 * What a lease owes for the period `now` falls in.
 *
 * A lease that started before this period owes full rent. A lease that
 * started mid-period owes a day-prorated share counting its start day as a
 * full day (ADR-0005 §5: billing edges decided in the ADR, not in a job's
 * edge cases). Rounding is CEILING — in the house's favour by at most one
 * minor unit, and never zero: a lease that exists owes something, because a
 * zero posting is not a payment and the ledger refuses empty amounts.
 *
 * Throws on non-positive rent rather than clamping: a free lease is a grant
 * and a negative one is a payout, and both deserve their own route if the
 * tower ever wants them.
 */
export function rentDueForPeriod(rentMinor: bigint, leaseStartedAt: Date, now: Date): bigint {
  if (typeof rentMinor !== "bigint" || rentMinor <= 0n) {
    throw new InvalidRent(`rent must be a positive bigint of minor units, got ${rentMinor}`);
  }
  if (periodKeyUTC(leaseStartedAt) !== periodKeyUTC(now)) return rentMinor;
  const days = BigInt(daysInPeriodUTC(now));
  const remaining = BigInt(daysInPeriodUTC(now) - leaseStartedAt.getUTCDate() + 1);
  return (rentMinor * remaining + days - 1n) / days;
}

// ── The panel ───────────────────────────────────────────────

/**
 * What a floor renders into its room. A TYPED schema, never markup
 * (ADR-0005 invariant): structured fields with bounded sizes, and any asset
 * URL restricted to the same host-allowlist discipline the Arcade enforces
 * on cabinets (`routes/arcade.ts` — .supabase.co / .openclawcity.ai /
 * .openbotcity.ai / .ninja-portal.com). A tenant must not be able to put
 * script, hostile embeds, or an attacker-hosted image in front of a
 * visitor's browser wearing the city's origin.
 */
export interface TowerPanel {
  headline?: string;
  lines?: string[];
  stats?: { label: string; value: string }[];
  /** One image, from an allowlisted host, https only. */
  assetUrl?: string;
  /** A room in this city the panel points visitors at (validated upstream
   *  against the room directory, not here — rooms are not pure data). */
  ctaRoomId?: string;
}

export const PANEL_ASSET_HOST_SUFFIXES = [
  ".supabase.co",
  ".openclawcity.ai",
  ".openbotcity.ai",
  ".ninja-portal.com",
] as const;

const PANEL_LIMITS = {
  headline: 120,
  lines: 6,
  lineLength: 200,
  stats: 6,
  statLabel: 40,
  statValue: 60,
} as const;

/** Control characters and ANSI escapes have no business on a wall. */
function cleanText(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

export function validatePanel(input: unknown):
  | { ok: true; panel: TowerPanel }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "panel must be an object" };
  }
  const raw = input as Record<string, unknown>;
  const panel: TowerPanel = {};

  if (raw.headline !== undefined) {
    const h = cleanText(raw.headline, PANEL_LIMITS.headline);
    if (h === null) return { ok: false, error: `headline must be a non-empty string of at most ${PANEL_LIMITS.headline} chars` };
    panel.headline = h;
  }

  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines) || raw.lines.length > PANEL_LIMITS.lines) {
      return { ok: false, error: `lines must be an array of at most ${PANEL_LIMITS.lines}` };
    }
    const lines: string[] = [];
    for (const l of raw.lines) {
      const c = cleanText(l, PANEL_LIMITS.lineLength);
      if (c === null) return { ok: false, error: `each line must be a non-empty string of at most ${PANEL_LIMITS.lineLength} chars` };
      lines.push(c);
    }
    panel.lines = lines;
  }

  if (raw.stats !== undefined) {
    if (!Array.isArray(raw.stats) || raw.stats.length > PANEL_LIMITS.stats) {
      return { ok: false, error: `stats must be an array of at most ${PANEL_LIMITS.stats}` };
    }
    const stats: { label: string; value: string }[] = [];
    for (const s of raw.stats) {
      if (!s || typeof s !== "object") return { ok: false, error: "each stat must be {label, value}" };
      const label = cleanText((s as Record<string, unknown>).label, PANEL_LIMITS.statLabel);
      const value = cleanText((s as Record<string, unknown>).value, PANEL_LIMITS.statValue);
      if (label === null || value === null) return { ok: false, error: "each stat needs a bounded label and value" };
      stats.push({ label, value });
    }
    panel.stats = stats;
  }

  if (raw.assetUrl !== undefined) {
    if (typeof raw.assetUrl !== "string") return { ok: false, error: "assetUrl must be a string" };
    let u: URL;
    try {
      u = new URL(raw.assetUrl);
    } catch {
      return { ok: false, error: "assetUrl must be a valid URL" };
    }
    // https only, allowlisted hosts only, suffix matched on a dot boundary so
    // `evil-supabase.co` and `supabase.co.attacker.example` both fail.
    if (u.protocol !== "https:") return { ok: false, error: "assetUrl must be https" };
    const host = u.hostname.toLowerCase();
    const allowed = PANEL_ASSET_HOST_SUFFIXES.some((suf) => host.endsWith(suf) && host.length > suf.length);
    if (!allowed) return { ok: false, error: `assetUrl host must end in one of: ${PANEL_ASSET_HOST_SUFFIXES.join(", ")}` };
    if (raw.assetUrl.length > 500) return { ok: false, error: "assetUrl too long" };
    panel.assetUrl = raw.assetUrl;
  }

  if (raw.ctaRoomId !== undefined) {
    const c = cleanText(raw.ctaRoomId, 40);
    if (c === null) return { ok: false, error: "ctaRoomId must be a short string" };
    panel.ctaRoomId = c;
  }

  const known = new Set(["headline", "lines", "stats", "assetUrl", "ctaRoomId"]);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) return { ok: false, error: `unknown panel field "${k}" — the panel is a typed schema, not a document` };
  }
  if (Object.keys(panel).length === 0) {
    return { ok: false, error: "panel is empty — send at least one field, or nothing at all" };
  }
  return { ok: true, panel };
}
