/**
 * capabilityGrants.test.ts — the grant is the authority record (#403, D2).
 *
 * DB-backed: the fail-closed reads and the narrow-bumps-version discipline are
 * the safety properties, so they run against the real table.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getGrant, setGrant } from "./capabilityGrants";

let seq = 0;
const principal = () => `kax:agent:00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

describe("capability grants (#403)", () => {
  beforeEach(() => {
    seq += 100;
  });

  it("no row means NO capability — fail closed", async () => {
    expect(await getGrant(principal(), "write-code")).toBeNull();
  });

  it("seeds a grant and reads it back", async () => {
    const p = principal();
    await setGrant({ principal: p, kind: "write-code", repos: ["flaukowski/sandbox"], branchPrefix: "agent/scada", updatedBy: "user:nick" });
    const g = await getGrant(p, "write-code");
    expect(g?.repos).toEqual(["flaukowski/sandbox"]);
    expect(g?.branchPrefix).toBe("agent/scada");
    expect(g?.tier).toBe(0);
  });

  it("narrowing bumps the version and is auditable", async () => {
    const p = principal();
    const v1 = await setGrant({ principal: p, kind: "write-code", repos: ["a/b", "c/d"], updatedBy: "user:nick" });
    expect(v1.version).toBe(1);
    const v2 = await setGrant({ principal: p, kind: "write-code", repos: ["a/b"], updatedBy: "user:nick" });
    expect(v2.version).toBe(2);
    expect((await getGrant(p, "write-code"))?.repos).toEqual(["a/b"]);
  });

  it("a disabled grant reads as NO capability", async () => {
    const p = principal();
    await setGrant({ principal: p, kind: "write-code", repos: ["a/b"], updatedBy: "user:nick" });
    expect(await getGrant(p, "write-code")).not.toBeNull();
    await setGrant({ principal: p, kind: "write-code", repos: ["a/b"], enabled: false, updatedBy: "user:nick" });
    expect(await getGrant(p, "write-code")).toBeNull();
  });

  it("keeps one row per (principal, kind)", async () => {
    const p = principal();
    await setGrant({ principal: p, kind: "write-code", repos: ["a/b"], updatedBy: "u" });
    await setGrant({ principal: p, kind: "write-code", repos: ["c/d"], updatedBy: "u" });
    const rows = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM capability_grants WHERE principal = ${p} AND kind = 'write-code'`,
    );
    const n = (rows as unknown as { rows?: { n: number }[] }).rows?.[0]?.n ?? 0;
    expect(n).toBe(1);
  });
});
