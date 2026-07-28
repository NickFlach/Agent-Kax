/**
 * liveRoleChecks.test.ts — authorization must never trust the cached session
 * role (#106).
 *
 * `req.user` is restored from the session payload by authMiddleware, so
 * `req.user.role` is whatever the role was AT SIGN-IN. Two read gates compared
 * against it directly:
 *
 *   routes/agents.ts   if (req.user!.role !== "admin" && agent.ownerId !== req.user!.id)
 *   routes/drops.ts    if (req.user!.role !== "admin") { scope to own artifacts }
 *
 * So an admin who was demoted to `user` kept cross-owner read access at both
 * until their session expired. Everywhere else already goes through
 * requireAdmin / canMutate / getOptionalAuth, each of which re-reads
 * users.role and users.disabledAt per request.
 *
 * Source-level on purpose: the defect is *which source a call site consults*,
 * not the behaviour of a function. A behavioural test would need the express +
 * database harness, and the repo's DB-backed suite talks to a real database —
 * which must not be exercised from a dev machine. This asserts the property
 * that actually regressed.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(__dirname, "..");

/** Every .ts source file under src/, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Lines that read `.role` off the request user, ignoring comments. */
function cachedRoleReads(src: string): string[] {
  return src
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
      return /req\.user!?\??\.role/.test(line);
    })
    .map((l) => l.trim());
}

describe("live role checks (#106)", () => {
  it("no route or lib reads the role off the cached session", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      for (const line of cachedRoleReads(fs.readFileSync(file, "utf8"))) {
        offenders.push(`${path.relative(SRC_DIR, file)}: ${line}`);
      }
    }
    expect(offenders, [
      "Authorization must re-read users.role per request — a demoted admin",
      "keeps their old role in the session until it expires. Use canMutate(),",
      "getOptionalAuth() or requireAdmin() instead of req.user.role.",
      "",
      ...offenders,
    ].join("\n")).toEqual([]);
  });

  it("the helpers these gates rely on do read the role from the database", () => {
    // Guards the other direction: if requireAuth stopped consulting the users
    // table, the assertion above would still pass while authorization silently
    // went stale everywhere.
    const mw = fs.readFileSync(path.join(SRC_DIR, "middlewares", "requireAuth.ts"), "utf8");
    for (const fn of ["requireAdmin", "canMutate", "getOptionalAuth"]) {
      const start = mw.indexOf(`export ${fn.startsWith("require") ? "async function" : "async function"} ${fn}`);
      expect(start, `${fn} not found in requireAuth.ts`).toBeGreaterThanOrEqual(0);
    }
    expect(mw).toContain("db.select().from(usersTable)");
    expect(mw).toContain("user.disabledAt");
  });
});
