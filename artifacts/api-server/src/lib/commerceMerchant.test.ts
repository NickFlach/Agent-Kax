/**
 * commerceMerchant.test.ts — #253's acceptance criteria.
 *
 * The unit half (status vocabulary, the directional satisfies() rule) needs
 * no database. The drop-and-repair half is DB-backed and runs in CI. The
 * darkness pin (zero routes reference the table) is a source walk, same
 * rationale as authorityDecisions.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { MERCHANT_STATUSES, isMerchantStatus, parseMerchantStatus, satisfies } from "./commerceMerchant";
import { ensureCriticalSchema } from "./ensureCriticalSchema";

const m = (buyerCipStatus: string, payeeKybStatus: string) => ({ buyerCipStatus, payeeKybStatus });

describe("merchant status vocabulary", () => {
  it("accepts exactly the four statuses", () => {
    for (const s of MERCHANT_STATUSES) expect(isMerchantStatus(s)).toBe(true);
  });

  it("rejects an unknown status string, naming it", () => {
    expect(isMerchantStatus("approved")).toBe(false);
    expect(isMerchantStatus(null)).toBe(false);
    expect(() => parseMerchantStatus("approved")).toThrow(/'approved' is not a merchant status/);
  });
});

describe("the directional rule: payee_kyb satisfies buyer_cip, never the reverse", () => {
  it("a KYB-verified merchant satisfies BOTH levels", () => {
    const kyb = m("none", "verified");
    expect(satisfies("payee_kyb", kyb)).toBe(true);
    expect(satisfies("buyer_cip", kyb)).toBe(true);
  });

  it("a CIP-verified merchant satisfies buyer_cip ONLY", () => {
    const cip = m("verified", "none");
    expect(satisfies("buyer_cip", cip)).toBe(true);
    // The dangerous inference, refused: a verified buyer has proven nothing
    // about where payouts may go.
    expect(satisfies("payee_kyb", cip)).toBe(false);
  });

  it("pending and failed satisfy nothing", () => {
    for (const s of ["none", "pending", "failed"] as const) {
      expect(satisfies("buyer_cip", m(s, s))).toBe(false);
      expect(satisfies("payee_kyb", m(s, s))).toBe(false);
    }
  });
});

describe("commerce_merchants drop-and-repair (DB)", () => {
  it("comes back after being dropped, via ensureCriticalSchema", async () => {
    await db.execute(sql`DROP TABLE IF EXISTS commerce_merchants CASCADE`);
    const r = await ensureCriticalSchema();
    expect(r.repaired).toBe(true);
    const probe = await db.execute(sql`SELECT to_regclass('public.commerce_merchants') AS t`);
    expect((probe.rows[0] as { t: string | null }).t).not.toBeNull();
  });
});

describe("darkness pin — zero routes reference the table (#253)", () => {
  it("no file under routes/ mentions commerce_merchants or its drizzle name", () => {
    const ROUTES = path.join(__dirname, "..", "routes");
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(ROUTES, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const src = fs.readFileSync(path.join(ROUTES, entry.name), "utf8");
      if (/commerce_merchants|commerceMerchantsTable/.test(src)) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });
});
