/**
 * identityScopes.test.ts — the `scopes` claim stays decoration (issue #252).
 *
 * KAX-ADR-0001 froze `scopes` as NON-AUTHORITATIVE: issued for wire
 * compatibility, never read as permission, authority resolved server-side at
 * evaluation time. The danger is drift — an implementer extends `scopes`, and
 * KAX ends up with two permission systems: a decorative one in the token that
 * remote verifiers can see, and a real one server-side that they cannot.
 *
 * Two halves, because each covers the other's blind spot:
 *
 * 1. A DRIFT ALARM (source-level, modeled on publicRouteGating.test.ts). It
 *    scans code lines — comments stripped — for the word `scopes` outside the
 *    files allowed to touch it. Word-level rather than `.scopes` on purpose:
 *    a member-spelling grep misses `const { scopes } = claims` and
 *    `claims["scopes"]`, which are readers in every sense that matters. This
 *    is an alarm, not a behavioural gate — computed access (`"sco" + "pes"`)
 *    still evades it, which is what the second half is for.
 *
 * 2. A BEHAVIOURAL RECEIPT. Mint tokens for the same principal differing ONLY
 *    in the scopes claim — the documented pair, an empty list, and the claim
 *    absent — and assert verification and principal derivation are identical
 *    across all three. If authority really is server-side, the claim can hold
 *    anything and nothing changes. A reader added by ANY spelling that
 *    influences identity handling breaks this, because it changes behaviour
 *    rather than text. (Full route-level equivalence needs the DB-backed
 *    harness; this is the DB-free half, pinned at the layer every route's
 *    authority derivation flows through.)
 *
 * Mutations run before this landed, each proving the half that owns it:
 *
 * - A scope gate inside verifyToken (allowlisted file): the RECEIPT went red,
 *   3 tests, while the alarm correctly stayed green — identity.ts is allowed
 *   to mention scopes, so behaviour is the only thing that can convict it.
 * - A reader exported from actor.ts (non-allowlisted): the ALARM went red on
 *   exactly that line. Spelled as destructuring it still trips, because the
 *   scan is word-level, not member-spelling.
 *
 * Neither half alone survives both mutations; the pair does. Computed access
 * (`"sco" + "pes"`) evades the alarm by construction — the receipt is what
 * stands in that corner, and only for readers that change behaviour.
 *
 * Needs DATABASE_URL SET but never CONNECTED: principalForClaims lives in
 * actor.ts, whose module-level `@workspace/db` import refuses to load without
 * the env var — but nothing here ever issues a query, so any well-formed URL
 * satisfies it (CI provides a real one; locally a dummy works). Importing the
 * real derivation is the point: asserting against a copy of it would pin the
 * copy, not the code routes actually run.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _resetKeyCache, issueToken, verifyToken, type IdentityClaims } from "./identity";
import { principalForClaims } from "./actor";

// ---------------------------------------------------------------------------
// Half 1 — the drift alarm.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, "..");

/**
 * The complete set of PRODUCTION files permitted to mention `scopes`: the
 * claim's definition and issuance plumbing, and the token-minting routes —
 * including routes/predictions.ts, which the issue text's allowlist omitted
 * but its own issuance-site list names.
 *
 * Test files are excluded from the walk entirely, not allowlisted: a test
 * minting a scoped fixture (occRevocationGates.test.ts) or asserting the
 * claim round-trips (identity.test.ts) is exercising issuance, and a reader
 * in a test cannot grant anybody permission. The alarm exists for the file
 * that will one day do authorization with the claim, and that file is
 * production code by definition.
 */
const ALLOWED = new Set([
  path.join("lib", "identity.ts"),
  path.join("routes", "identity.ts"),
  path.join("routes", "predictions.ts"),
]);

/** Source with comment-only lines dropped, so prose never trips the alarm. */
function code(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

describe("drift alarm — no new file mentions scopes", () => {
  it("finds the word `scopes` only in the files allowed to issue or carry it", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      const lines = code(fs.readFileSync(file, "utf8")).split("\n");
      for (const line of lines) {
        // Word-boundary match so `roomChat.ts`'s prose about a room "scoping"
        // a conversation, or identifiers like `scopedToken`, never alarm.
        if (/\bscopes\b/.test(line)) {
          offenders.push(`${rel}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(
      offenders,
      "a file outside the allowlist mentions `scopes`. If it reads the claim, " +
        "STOP: scopes is frozen non-authoritative (issue #252, ADR-0001) — " +
        "authority is looked up server-side, never from the token. If the " +
        "mention is legitimate plumbing, argue it into ALLOWED in this test.",
    ).toEqual([]);
  });

  it("still sees the issuance sites, so the alarm cannot rot into a tautology", () => {
    // If routes/identity.ts stopped mentioning scopes entirely, the allowlist
    // would be guarding nothing and this file would pass forever on an empty
    // scan. Assert the claim is still issued where the freeze says it is —
    // the day this fails, the claim was removed, and this whole test retires
    // with it (the deliberate token-format change ADR-0001 anticipates).
    const identity = code(
      fs.readFileSync(path.join(SRC, "routes", "identity.ts"), "utf8"),
    );
    expect(/\bscopes\b/.test(identity)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Half 2 — the behavioural receipt.
// ---------------------------------------------------------------------------

const ENV_KEY = "KAX_IDENTITY_PRIVATE_JWK";
let envBefore: string | undefined;

beforeAll(() => {
  envBefore = process.env[ENV_KEY];
  // A throwaway Ed25519 key so minting works without the deployed secret.
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  process.env[ENV_KEY] = JSON.stringify(jwk);
  _resetKeyCache();
});

afterAll(() => {
  if (envBefore === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = envBefore;
  _resetKeyCache();
});

const BOT = "b757bd93-6993-400b-9dd4-9d38bf257c67";
// One REAL timestamp shared by every mint: identical iat/nbf/exp/oat across
// tokens (so the equality assertion is exact), and a live exp — jose checks
// expiry against the wall clock, so a nostalgic deterministic epoch here mints
// tokens that are born expired and fails verification for the wrong reason.
const NOW = Math.floor(Date.now() / 1000);

async function mintAndVerify(scopes: string[] | undefined): Promise<IdentityClaims> {
  const token = await issueToken({
    kind: "agent",
    subject: "same-subject",
    botId: BOT,
    scopes,
    ttlSeconds: 900,
    now: NOW,
  });
  const v = await verifyToken(token);
  expect(v.ok, "token must verify regardless of its scopes claim").toBe(true);
  return (v as { ok: true; claims: IdentityClaims }).claims;
}

describe("behavioural receipt — scope content cannot influence identity", () => {
  it("derives the identical principal whatever the scopes claim holds", async () => {
    const documented = await mintAndVerify(["propose", "trade"]);
    const empty = await mintAndVerify([]);
    const absent = await mintAndVerify(undefined);

    const principals = [documented, empty, absent].map((c) => principalForClaims(c));
    expect(principals).toEqual([
      `kax:agent:${BOT}`,
      `kax:agent:${BOT}`,
      `kax:agent:${BOT}`,
    ]);
  });

  it("verifies to claims identical in everything except the decoration itself", async () => {
    const documented = await mintAndVerify(["propose", "trade"]);
    const absent = await mintAndVerify(undefined);

    // jti differs by construction (a fresh UUID per mint); scopes is the field
    // under test. Everything else — kind, bot_id, sub, iss, iat, nbf, exp,
    // oat — must be byte-equal, or the claim leaked into minting behaviour.
    const strip = (c: IdentityClaims) => {
      const { jti: _jti, scopes: _scopes, ...rest } = c;
      return rest;
    };
    expect(strip(documented)).toEqual(strip(absent));

    // And the issued shapes are exactly the documented pair and nothing:
    expect(documented.scopes).toEqual(["propose", "trade"]);
    expect(absent.scopes).toBeUndefined();
  });

  it("treats an empty scopes list as no claim at all, not as a third state", async () => {
    // issueToken writes the claim only for a non-empty list. Pinned because
    // an implementer seeing `scopes: []` versus the field missing might read
    // the difference as meaningful — there must not BE a difference to read.
    const empty = await mintAndVerify([]);
    expect(empty.scopes).toBeUndefined();
  });
});
