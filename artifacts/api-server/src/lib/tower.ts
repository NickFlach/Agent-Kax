import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  towerFloorsTable,
  towerLeasesTable,
  type TowerFloor,
  type TowerLease,
} from "@workspace/db/schema";
import { HOUSE_ACCOUNT, minorToCreditsString } from "./ledger-core";
import { LedgerIdempotencyConflict, LedgerInsufficientFunds, postTransaction } from "./ledger";
import {
  isLeasableTowerFloor,
  leaseTxId,
  periodKeyUTC,
  rentDueForPeriod,
  validatePanel,
  type TowerPanel,
} from "./tower-core";
import { isKnownRoom, parseUnitRoom, towerRoom } from "./rooms";

/**
 * Ghost Signals Tower, operating (KAX-ADR-0005).
 *
 * The registry and lease lifecycle live here; the arithmetic and the panel
 * schema live in tower-core. This module is LEDGER-ADJACENT in exactly one
 * place — billPeriod — and nowhere else: the panel path, the directory, and
 * the darkening switch must never be able to move money (the #286-style
 * structural rule, kept structural by keeping postTransaction out of every
 * other function).
 *
 * The principal grammar is the city's one grammar: a tenant is
 * `kax:agent:<bot_id>` and pays from `trader:kax:agent:<bot_id>`, the same
 * account the joinery debits. Nothing tower-shaped invents an account form.
 */

export class TowerFloorUnavailable extends Error {
  readonly code = "tower_floor_unavailable";
}
export class TowerFloorNotFound extends Error {
  readonly code = "tower_floor_not_found";
}
export class NotYourFloor extends Error {
  readonly code = "not_your_floor";
}
export class FloorIsDark extends Error {
  readonly code = "tower_floor_dark";
}
export class BadPanel extends Error {
  readonly code = "bad_panel";
}

// Lowercase ONLY — no `i` flag. A grant stores whatever the operator typed,
// and the panel writer compares it against the principal derived from the DB
// (lowercase), so an uppercase grant would lock a legitimate tenant out of
// their own wall AND bill a lookalike ledger account. grantTowerLease
// normalizes before this test, so mixed-case input still lands correctly.
const PRINCIPAL_RE = /^kax:agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function floorRow(floorNo: number): Promise<TowerFloor | undefined> {
  const [row] = await db.select().from(towerFloorsTable).where(eq(towerFloorsTable.floorNo, floorNo)).limit(1);
  return row;
}

async function activeLease(floorNo: number): Promise<TowerLease | undefined> {
  const [row] = await db
    .select()
    .from(towerLeasesTable)
    .where(and(eq(towerLeasesTable.floorNo, floorNo), eq(towerLeasesTable.state, "active")))
    .orderBy(desc(towerLeasesTable.id))
    .limit(1);
  return row;
}

/** The public building directory: every storey, its state, who is on it. */
export async function towerDirectory() {
  const floors = await db.select().from(towerFloorsTable).orderBy(towerFloorsTable.floorNo);
  return floors.map((f) => ({
    floorNo: f.floorNo,
    room: towerRoom(f.floorNo),
    status: f.status,
    slug: f.slug,
    label: f.label,
    repoUrl: f.repoUrl,
    tenantPrincipal: f.tenantPrincipal,
    darkReason: f.status === "dark" ? f.darkReason : null,
  }));
}

/** One floor, with its lease terms — what an applicant or visitor may know. */
export async function towerFloorView(floorNo: number) {
  if (!isLeasableTowerFloor(floorNo)) throw new TowerFloorNotFound(`floor ${floorNo} is not a leasable storey (2-11)`);
  const f = await floorRow(floorNo);
  if (!f) throw new TowerFloorNotFound(`floor ${floorNo} is not in the registry`);
  const lease = f.status === "vacant" ? undefined : await activeLease(floorNo);
  return {
    floorNo: f.floorNo,
    room: towerRoom(f.floorNo),
    status: f.status,
    slug: f.slug,
    label: f.label,
    repoUrl: f.repoUrl,
    tenantPrincipal: f.tenantPrincipal,
    darkReason: f.status === "dark" ? f.darkReason : null,
    panel: f.status === "leased" ? (f.panel as TowerPanel | null) : null,
    lease: lease
      ? {
          rentMinor: lease.rentMinor.toString(),
          rentCredits: minorToCreditsString(lease.rentMinor),
          startedAt: lease.startedAt,
          state: lease.state,
        }
      : null,
  };
}

/**
 * Grant a lease on a vacant floor. Operator action (the review happened in
 * the tenancy PR; this is the registry catching up with the merge). The
 * first rent posting is NOT made here — billing is billPeriod's only job,
 * so the grant stays idempotent-retryable without money side effects.
 */
export async function grantTowerLease(input: {
  floorNo: number;
  tenantPrincipal: string;
  slug: string;
  label: string;
  repoUrl: string;
  rentMinor: bigint;
}): Promise<{ floorNo: number; leaseId: number }> {
  const { floorNo } = input;
  if (!isLeasableTowerFloor(floorNo)) throw new TowerFloorNotFound(`floor ${floorNo} is not a leasable storey (2-11)`);
  const tenantPrincipal = String(input.tenantPrincipal ?? "").trim().toLowerCase();
  if (!PRINCIPAL_RE.test(tenantPrincipal)) {
    throw new TowerFloorUnavailable(`tenantPrincipal must be kax:agent:<bot uuid>, got "${input.tenantPrincipal}"`);
  }
  if (typeof input.rentMinor !== "bigint" || input.rentMinor <= 0n) {
    throw new TowerFloorUnavailable("rentMinor must be a positive bigint");
  }
  const f = await floorRow(floorNo);
  if (!f) throw new TowerFloorNotFound(`floor ${floorNo} is not in the registry`);
  if (f.status !== "vacant") throw new TowerFloorUnavailable(`floor ${floorNo} is ${f.status}, not vacant`);

  try {
    return await db.transaction(async (tx) => {
      const [lease] = await tx
        .insert(towerLeasesTable)
        .values({
          floorNo,
          tenantPrincipal,
          rentMinor: input.rentMinor,
        })
        .returning();
      await tx
        .update(towerFloorsTable)
        .set({
          status: "leased",
          slug: input.slug.slice(0, 60),
          label: input.label.slice(0, 80),
          repoUrl: input.repoUrl.slice(0, 300),
          tenantPrincipal,
          darkReason: null,
          updatedAt: new Date(),
        })
        .where(eq(towerFloorsTable.floorNo, floorNo));
      return { floorNo, leaseId: lease!.id };
    });
  } catch (e) {
    // The unique indexes are the invariants speaking: one floor per tenant
    // (tower_floors_tenant_unique) and one active lease per floor
    // (tower_leases_one_active_per_floor). Surface them as the refusals they
    // are, not as a 500 on an operator surface.
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      throw new TowerFloorUnavailable(
        `${tenantPrincipal} already holds a floor, or floor ${floorNo} already has an active lease — one each`,
      );
    }
    throw e;
  }
}

/** Dim a floor: door stays, service refused. A switch, never a delete. */
export async function darkenTowerFloor(floorNo: number, reason: string): Promise<void> {
  const f = await floorRow(floorNo);
  if (!f) throw new TowerFloorNotFound(`floor ${floorNo} is not in the registry`);
  if (f.status !== "leased") throw new TowerFloorUnavailable(`floor ${floorNo} is ${f.status}; only a leased floor can go dark`);
  await db
    .update(towerFloorsTable)
    .set({ status: "dark", darkReason: reason.slice(0, 300), updatedAt: new Date() })
    .where(eq(towerFloorsTable.floorNo, floorNo));
}

export async function undarkenTowerFloor(floorNo: number): Promise<void> {
  const f = await floorRow(floorNo);
  if (!f) throw new TowerFloorNotFound(`floor ${floorNo} is not in the registry`);
  if (f.status !== "dark") throw new TowerFloorUnavailable(`floor ${floorNo} is ${f.status}, not dark`);
  await db
    .update(towerFloorsTable)
    .set({ status: "leased", darkReason: null, updatedAt: new Date() })
    .where(eq(towerFloorsTable.floorNo, floorNo));
}

/**
 * End a lease: the floor returns to vacancy, the panel comes off the wall.
 * In-flight ledger obligations are untouched — they are ordinary postings,
 * not floor state (ADR-0005 §5).
 */
export async function endTowerLease(floorNo: number): Promise<void> {
  const f = await floorRow(floorNo);
  if (!f) throw new TowerFloorNotFound(`floor ${floorNo} is not in the registry`);
  if (f.status === "vacant") throw new TowerFloorUnavailable(`floor ${floorNo} is already vacant`);
  await db.transaction(async (tx) => {
    await tx
      .update(towerLeasesTable)
      .set({ state: "ended", endedAt: new Date() })
      .where(and(eq(towerLeasesTable.floorNo, floorNo), eq(towerLeasesTable.state, "active")));
    await tx
      .update(towerFloorsTable)
      .set({
        status: "vacant",
        slug: null,
        label: null,
        repoUrl: null,
        tenantPrincipal: null,
        panel: null,
        darkReason: null,
        updatedAt: new Date(),
      })
      .where(eq(towerFloorsTable.floorNo, floorNo));
  });
}

/**
 * The tenant updates what their floor shows. Agent-authed upstream; here we
 * hold the two gates that are the floor's, not the router's: it must be YOUR
 * floor, and a dark floor's wall takes nothing.
 */
export async function writeTowerPanel(
  floorNo: number,
  agentPrincipal: string,
  rawPanel: unknown,
): Promise<TowerPanel> {
  const f = await floorRow(floorNo);
  if (!f) throw new TowerFloorNotFound(`floor ${floorNo} is not in the registry`);
  if (f.status === "dark") throw new FloorIsDark(`floor ${floorNo} is dark: ${f.darkReason ?? "no reason recorded"}`);
  if (f.status !== "leased" || f.tenantPrincipal !== agentPrincipal) {
    throw new NotYourFloor(`floor ${floorNo} is not leased to ${agentPrincipal}`);
  }
  const v = validatePanel(rawPanel);
  if (!v.ok) throw new BadPanel(v.error);
  if (v.panel.ctaRoomId) {
    // A directory room only: private flats are real, addressable and
    // unlisted (rooms.ts), and a business's wall must not advertise the way
    // to somebody's home.
    if (!isKnownRoom(v.panel.ctaRoomId) || parseUnitRoom(v.panel.ctaRoomId) !== null) {
      throw new BadPanel(`ctaRoomId "${v.panel.ctaRoomId}" is not a public room in this city`);
    }
  }
  await db
    .update(towerFloorsTable)
    .set({ panel: v.panel, updatedAt: new Date() })
    .where(eq(towerFloorsTable.floorNo, floorNo));
  return v.panel;
}

export interface BillReport {
  period: string;
  posted: { floorNo: number; txId: string; amountMinor: string; idempotentReplay: boolean }[];
  skipped: { floorNo: number; reason: string }[];
}

/**
 * Post this period's rent for every active lease. Idempotent end to end: the
 * txId is `lease:tower:<floor>:<period>`, so running twice replays instead of
 * double-billing. An insufficient balance darkens NOTHING here — delinquency
 * is an operator decision made looking at this report, not a side effect of
 * a job (a tenant one credit short at midnight does not deserve an
 * unattended blackout).
 */
export async function billTowerPeriod(now: Date = new Date()): Promise<BillReport> {
  const period = periodKeyUTC(now);
  const leases = await db.select().from(towerLeasesTable).where(eq(towerLeasesTable.state, "active"));
  const report: BillReport = { period, posted: [], skipped: [] };
  for (const lease of leases) {
    const due = rentDueForPeriod(lease.rentMinor, lease.startedAt, now);
    const txId = leaseTxId(lease.floorNo, period);
    const ref = `tower rent: floor ${lease.floorNo}, ${period}`;
    try {
      const posted = await postTransaction({
        txId,
        asset: "play_credit",
        postings: [
          { account: `trader:${lease.tenantPrincipal}`, amount: -due, kind: "tower_rent", ref },
          { account: HOUSE_ACCOUNT, amount: due, kind: "tower_rent", ref },
        ],
        actor: "system:tower-billing",
        capability: "credits.move",
      });
      report.posted.push({
        floorNo: lease.floorNo,
        txId,
        amountMinor: due.toString(),
        idempotentReplay: posted.idempotentReplay,
      });
    } catch (e) {
      if (e instanceof LedgerInsufficientFunds) {
        report.skipped.push({ floorNo: lease.floorNo, reason: "insufficient_funds" });
        continue;
      }
      // The txId is floor-scoped: one rent per floor per period, whoever the
      // tenant is. A floor re-leased mid-month (even to the same tenant, whose
      // new startedAt changes the prorated amount) replays the txId with
      // DIFFERENT postings, which the ledger correctly refuses. That refusal
      // is this floor's fact, not the run's: swallow it into the report, or
      // one re-leased floor stops every floor after it from being billed for
      // the rest of the month (review finding 1).
      if (e instanceof LedgerIdempotencyConflict) {
        report.skipped.push({ floorNo: lease.floorNo, reason: "period_already_billed" });
        continue;
      }
      throw e;
    }
  }
  return report;
}

/** What the floor's room renders — the panel plus the facts on the door. */
export async function towerRoomView(floorNo: number) {
  const view = await towerFloorView(floorNo);
  return {
    floorNo: view.floorNo,
    room: view.room,
    status: view.status,
    label: view.label,
    repoUrl: view.repoUrl,
    panel: view.panel,
    // ADR-0005 disclosure invariant: speech addressed to a floor may be
    // forwarded to the tenant's own infrastructure once the webhook feed
    // exists (Phase 1). The signage ships BEFORE the feed does, so the room
    // never listens quietly even for a day.
    signage:
      view.status === "leased"
        ? `This floor is operated by an outside business on its own open-source code (${view.repoUrl ?? "repo on file"}). What you say to it may reach the tenant's systems.`
        : view.status === "dark"
          ? "This floor is dark. The door stays; the service is refused."
          : "This floor is vacant. Apply at tower/tenancies in the Agent-Kax repo.",
  };
}
