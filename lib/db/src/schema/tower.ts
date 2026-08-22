import { pgTable, serial, bigserial, integer, text, bigint, jsonb, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Ghost Signals Tower (KAX-ADR-0005) — leased floors for third-party
 * applications.
 *
 * NAMING: nothing here is called bare "floor" — that word belongs to the
 * MARKET floor ledger (routes/floor.ts, ADR-0041). These are tower_* tables
 * and the column is floor_no. The ADR's naming rule, enforced by vocabulary.
 *
 * The tower mirrors Standing Wave Residences' established storey count on the
 * operator's instruction: floors 2–11 are leasable (ten of them), the ground
 * floor is the Ghost Signals Trading Floor serving as lobby, and there is no
 * penthouse to argue about. Scarcity is the point of a tower.
 *
 * A floor row with a NULL tenant is VACANT — the building's honest default,
 * exactly like the residences. A floor is a LEASE, not a deployment: the row
 * binds a public open-source repo and a tenant principal; the tenant's code
 * runs on the tenant's own infrastructure, never here.
 */
export const towerFloorsTable = pgTable(
  "tower_floors",
  {
    id: serial("id").primaryKey(),
    /** 2–11. The ground floor is the trading-floor lobby and is not a row. */
    floorNo: integer("floor_no").notNull(),
    /** "vacant" | "leased" | "dark". Dark keeps the door rendered and the
     *  service refused — dimming is a switch, never a delete. */
    status: text("status").notNull().default("vacant"),
    /** Application slug — matches tower/tenancies/<slug>/TENANCY.md. */
    slug: text("slug"),
    /** The business name on the door. */
    label: text("label"),
    /** The public open-source repo of record. Correspondence between this
     *  repo and the deployed service is a lease term (ADR-0005 §2). */
    repoUrl: text("repo_url"),
    /** Tenant, in the one canonical `kax:agent:<bot_id>` spelling. NULL = vacant. */
    tenantPrincipal: text("tenant_principal"),
    /**
     * What the floor's room renders — a TYPED panel (headline, lines, stats,
     * one allowlisted asset), validated by tower-core before it is ever
     * stored. Never markup: a tenant must not put script in front of a
     * visitor's browser wearing the city's origin.
     */
    panel: jsonb("panel"),
    /** Why the floor is dark, when it is. */
    darkReason: text("dark_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tower_floors_floor_no_unique").on(t.floorNo),
    // One floor per tenant: a business gets one storey, not a monopoly.
    // NULLs are distinct in Postgres, so every vacant floor coexists freely.
    uniqueIndex("tower_floors_tenant_unique").on(t.tenantPrincipal),
    check("tower_floors_floor_no_range", sql`${t.floorNo} BETWEEN 2 AND 11`),
    check("tower_floors_status_known", sql`${t.status} IN ('vacant', 'leased', 'dark')`),
  ],
);

export type TowerFloor = typeof towerFloorsTable.$inferSelect;
export type InsertTowerFloor = typeof towerFloorsTable.$inferInsert;

/**
 * The lease behind a floor. Rent is play credits at the ADR-0001 peg, in
 * minor units, billed per UTC calendar month with a deterministic
 * `lease:tower:<floor_no>:<YYYY-MM>` txId (idempotent like every other
 * ledger trigger). There are no refunds: rent buys a revocable license for a
 * period (ADR-0005 §5), and a lease ending is a state flip, never a payout.
 */
export const towerLeasesTable = pgTable(
  "tower_leases",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    floorNo: integer("floor_no").notNull(),
    tenantPrincipal: text("tenant_principal").notNull(),
    /** Per-period rent in ledger minor units (1 credit = 1,000,000 minor). */
    rentMinor: bigint("rent_minor", { mode: "bigint" }).notNull(),
    /** "active" | "ended". */
    state: text("state").notNull().default("active"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("tower_leases_floor_idx").on(t.floorNo),
    index("tower_leases_state_idx").on(t.state),
    check("tower_leases_state_known", sql`${t.state} IN ('active', 'ended')`),
    check("tower_leases_rent_positive", sql`${t.rentMinor} > 0`),
  ],
);

export type TowerLease = typeof towerLeasesTable.$inferSelect;
export type InsertTowerLease = typeof towerLeasesTable.$inferInsert;

// The storey list (2–11) is deliberately NOT exported from here: the room
// directory in api-server lib/rooms.ts is its one definition (`TOWER_FLOOR_NOS`
// + `towerRoom`), the same one-definition rule residence floors follow. The
// CHECK constraints above encode the same range at the database's own level.
