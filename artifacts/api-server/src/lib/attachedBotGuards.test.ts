/**
 * attachedBotGuards.test.ts — attached-bot mutations all require wallet auth
 * (#112).
 *
 * `requireWalletAuth` exists specifically to gate these; its own docstring says
 * so:
 *
 *   "Used to gate OBC-bot ATTACHMENT endpoints — wallet is canonical identity,
 *    so OIDC-only or grandfathered `obc_agent:` sessions cannot attach a bot to
 *    themselves."
 *
 * All four ATTACH routes honoured that. `DELETE /auth/bots/:botId` — the
 * DETACH route — used plain `requireAuth`, so a grandfathered `obc_agent:`
 * session with no wallet could undo a wallet-proven attestation it could never
 * have created. Attaching needed the wallet; detaching did not.
 *
 * Source-level on purpose: the defect is which middleware a route is mounted
 * with. A behavioural test would need the express + session + database harness,
 * and this repo's DB-backed suite talks to a real database, which must not be
 * exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTES = path.join(__dirname, "..", "routes");

function read(file: string): string {
  return fs.readFileSync(path.join(ROUTES, file), "utf8");
}

/** Route registrations as `[method, routePath, firstMiddleware]`. */
function routeGuards(src: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push([m[1]!.toUpperCase(), m[2]!, m[3]!]);
  }
  return out;
}

describe("attached-bot guards (#112)", () => {
  it("every attached-bot MUTATION requires wallet auth", () => {
    const guards = [
      ...routeGuards(read("auth-bots.ts")),
      ...routeGuards(read("auth-agent.ts")),
    ];
    const mutations = guards.filter(([method]) => method !== "GET");
    expect(mutations.length, "expected to find the attach/detach routes").toBeGreaterThan(0);

    const weak = mutations.filter(([, , mw]) => mw !== "requireWalletAuth");
    expect(
      weak.map(([m, p, mw]) => `${m} ${p} -> ${mw}`),
      [
        "Attached-bot mutations must be gated by requireWalletAuth, not requireAuth.",
        "Wallet is canonical identity here; a grandfathered obc_agent: session",
        "must not be able to attach OR detach.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("the detach route specifically is wallet-gated", () => {
    // Named explicitly so the regression is obvious in the failure output,
    // rather than hidden in a list.
    const guards = routeGuards(read("auth-bots.ts"));
    const del = guards.find(([m, p]) => m === "DELETE" && p === "/auth/bots/:botId");
    expect(del, "DELETE /auth/bots/:botId not found").toBeDefined();
    expect(del![2]).toBe("requireWalletAuth");
  });

  it("requireWalletAuth still actually checks the wallet", () => {
    // Guards the other direction: the assertions above would pass vacuously if
    // requireWalletAuth were weakened to a pass-through.
    const mw = fs.readFileSync(
      path.join(__dirname, "..", "middlewares", "requireWalletAuth.ts"), "utf8");
    expect(mw).toContain('startsWith("wallet:")');
    expect(mw).toContain("user.walletAddress");
    expect(mw).toContain("user.disabledAt");
  });

  it("reads may stay on requireAuth", () => {
    // Listing your own attachments is not a mutation; this documents that the
    // rule above is deliberately scoped to writes.
    const list = routeGuards(read("auth-bots.ts"))
      .find(([m, p]) => m === "GET" && p === "/auth/bots");
    expect(list).toBeDefined();
    expect(["requireAuth", "requireWalletAuth"]).toContain(list![2]);
  });
});
