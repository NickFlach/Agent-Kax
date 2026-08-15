/**
 * attachedBotGuards.test.ts — a weaker credential must never undo a stronger
 * attestation (#112).
 *
 * The original hole: all four ATTACH routes required a wallet, but
 * `DELETE /auth/bots/:botId` used plain `requireAuth` — so a grandfathered
 * `obc_agent:` session could undo a wallet-proven attestation it could never
 * have created. Attaching needed the wallet; detaching did not.
 *
 * This file used to enforce that by requiring the literal middleware
 * `requireWalletAuth` on every mutation. That worked while a blanket wallet
 * requirement WAS the mechanism, and it correctly failed the moment the
 * mechanism changed — which is the test doing its job, not a nuisance.
 *
 * But the mechanism was never the point. Requiring a wallet to ATTACH
 * protected nothing: control of a bot is proved by publishing a challenge
 * phrase from it, and an Ethereum key says nothing about who runs that bot.
 * It only kept OCC-verified residents out of their own storefront.
 *
 * So the invariant is now asserted directly, and in a form the old test could
 * not express: a route that CHANGES an existing attachment must either demand
 * a wallet outright, or perform the runtime strength check. A route mounted on
 * plain `requireAuth` with NO check is precisely #112, and it is exactly the
 * intermediate state this branch passed through for one commit — so the test
 * that would have caught that is the one worth having.
 *
 * Source-level on purpose: the defect is structural, and a behavioural version
 * needs the express + session + database harness (which the sibling
 * botAttachAuth.test.ts provides for the behaviour itself).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTES = path.join(__dirname, "..", "routes");
const MIDDLEWARES = path.join(__dirname, "..", "middlewares");

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), "utf8");
}

interface RouteReg {
  method: string;
  routePath: string;
  middleware: string;
  /** Source from this registration up to the next one — the handler body. */
  body: string;
}

function routes(src: string): RouteReg[] {
  const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)/g;
  const found: Array<{ method: string; routePath: string; middleware: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    found.push({ method: m[1]!.toUpperCase(), routePath: m[2]!, middleware: m[3]!, at: m.index });
  }
  return found.map((f, i) => ({
    method: f.method,
    routePath: f.routePath,
    middleware: f.middleware,
    body: src.slice(f.at, i + 1 < found.length ? found[i + 1]!.at : src.length),
  }));
}

/** Routes that modify an attachment that already exists. */
const CHANGES_AN_ATTACHMENT = (r: RouteReg) =>
  r.method !== "GET" &&
  !r.routePath.endsWith("/auth/agent/challenge") &&
  !r.routePath.endsWith("/auth/agent/verify");

describe("attached-bot guards (#112)", () => {
  const all = [...routes(read(ROUTES, "auth-bots.ts")), ...routes(read(ROUTES, "auth-agent.ts"))];

  it("finds the attach/detach routes at all", () => {
    // Guards the guard: every assertion below is vacuous if the parser stops
    // matching, and a silently empty list would pass everything.
    expect(all.length).toBeGreaterThan(5);
    expect(all.some((r) => r.method === "DELETE" && r.routePath === "/auth/bots/:botId")).toBe(true);
  });

  it("no mutation is left ungated", () => {
    const ACCEPTED = ["requireWalletAuth", "requireAttachAuth", "requireAuth"];
    const ungated = all
      .filter((r) => r.method !== "GET")
      .filter((r) => !ACCEPTED.includes(r.middleware))
      .map((r) => `${r.method} ${r.routePath} -> ${r.middleware}`);
    expect(ungated, "an attached-bot mutation with no auth middleware").toEqual([]);
  });

  it("every route that CHANGES an attachment checks the strength that made it", () => {
    const holes = all
      .filter(CHANGES_AN_ATTACHMENT)
      .filter((r) => r.middleware !== "requireWalletAuth" && !r.body.includes("mayChangeBot"))
      .map((r) => `${r.method} ${r.routePath} -> ${r.middleware}, no mayChangeBot`);

    expect(
      holes,
      [
        "This is #112. A route that changes an existing attachment must either",
        "demand a wallet outright, or call mayChangeBot() so a session weaker",
        "than the one that attached is refused. Plain requireAuth with neither",
        "lets an email-only session undo a wallet-proven attestation.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("the detach route specifically is covered", () => {
    // Named so the regression is obvious in the output rather than in a list.
    const del = all.find((r) => r.method === "DELETE" && r.routePath === "/auth/bots/:botId");
    expect(del, "DELETE /auth/bots/:botId not found").toBeDefined();
    expect(
      del!.middleware === "requireWalletAuth" || del!.body.includes("mayChangeBot"),
      `detach is on ${del!.middleware} with no strength check`,
    ).toBe(true);
  });

  it("attaching records the strength it was attached with", () => {
    // Without this the strength check has nothing to compare against, and
    // every row would silently fall back to the column default.
    const verify = all.find((r) => r.routePath === "/auth/agent/verify");
    expect(verify, "verify route not found").toBeDefined();
    expect(verify!.body).toContain("sessionStrength");
    expect(verify!.body).toContain("attachedVia");
  });

  it("mayChangeBot actually compares strengths", () => {
    // The assertions above would pass vacuously if it were a pass-through.
    const mw = read(MIDDLEWARES, "botAttachAuth.ts");
    expect(mw).toContain("attachedVia");
    expect(mw).toContain('"wallet"');
    expect(mw).toMatch(/res\.status\(403\)/);
  });

  it("requireWalletAuth still actually checks the wallet", () => {
    const mw = read(MIDDLEWARES, "requireWalletAuth.ts");
    expect(mw).toContain('startsWith("wallet:")');
    expect(mw).toContain("user.walletAddress");
    expect(mw).toContain("user.disabledAt");
  });

  it("reads may stay on requireAuth", () => {
    const list = all.find((r) => r.method === "GET" && r.routePath === "/auth/bots");
    expect(list).toBeDefined();
    expect(["requireAuth", "requireWalletAuth"]).toContain(list!.middleware);
  });
});
