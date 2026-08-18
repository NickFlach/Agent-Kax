/**
 * attribution-core.test.ts — issue #348's acceptance criteria, verbatim.
 *
 * The property under test is NOT chain integrity. It is that attribution
 * survives an adversary who can rebuild the chain — because a rebuilt chain is
 * perfectly self-consistent, and "the hashes all verify" is exactly what a
 * successful forgery looks like. The reseal test below constructs that forgery
 * and asserts the chain half passes while the identity half refuses.
 *
 * Mutation that proves these tests are real (from #348): remove the signature
 * check — verify on the trailer/principal alone — and the two tests marked
 * MUTATION-SENSITIVE below must go red. A suite that stays green without the
 * signature check is asserting chain integrity, which was never the property
 * in dispute.
 *
 * Needs no DATABASE_URL: attribution-core imports nothing from @workspace/db.
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACTION_GENESIS_HASH,
  buildSignedAction,
  computeActionHash,
  formatTrailers,
  parseTrailers,
  signAction,
  verifyActionAttribution,
  verifyActionChain,
  type ActionEntry,
  type KeyRegistry,
  type SignedActionRow,
} from "./attribution-core";

const COLONIST = "kax:agent:c0104157-0000-4000-8000-00000000c01e";
const QE = "kax:agent:b757bd93-6993-400b-9dd4-9d38bf257c67";
const IMPOSTOR = "kax:agent:0000f04e-0000-4000-8000-000000000bad";

let keys: Map<string, crypto.KeyObject>;
let privs: Map<string, crypto.KeyObject>;

function makeAgent(principal: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  keys.set(principal, publicKey);
  privs.set(principal, privateKey);
}

/** An honest three-entry record: two acts by one agent, one by another. */
function honestChain(): SignedActionRow[] {
  const entries: [string, ActionEntry][] = [
    [COLONIST, { commitmentId: "cmt-1", principal: COLONIST, kind: "write-code", commitSha: "a".repeat(40), ref: "Agent-Kax#348" }],
    [COLONIST, { commitmentId: "cmt-2", principal: COLONIST, kind: "review-code", commitSha: null, ref: "Agent-Kax#343" }],
    [QE, { commitmentId: "cmt-3", principal: QE, kind: "write-code", commitSha: "b".repeat(40), ref: "Agent-Kax#346" }],
  ];
  const rows: SignedActionRow[] = [];
  let head = ACTION_GENESIS_HASH;
  entries.forEach(([who, e], i) => {
    const row = buildSignedAction(head, i + 1, e, privs.get(who)!);
    rows.push(row);
    head = row.entryHash;
  });
  return rows;
}

/**
 * The forger's move: change what history says, then recompute every hash so
 * the chain is self-consistent again. This is cheap and mechanical — nothing
 * about a hash chain requires a secret — which is the whole reason a chain
 * alone cannot carry attribution.
 */
function reseal(rows: SignedActionRow[]): SignedActionRow[] {
  let head = ACTION_GENESIS_HASH;
  return rows.map((r) => {
    const entry: ActionEntry = {
      commitmentId: r.commitmentId,
      principal: r.principal,
      kind: r.kind,
      commitSha: r.commitSha,
      ref: r.ref,
    };
    const entryHash = computeActionHash(head, r.seq, entry);
    const out = { ...r, prevHash: head, entryHash };
    head = entryHash;
    return out;
  });
}

beforeAll(() => {
  keys = new Map();
  privs = new Map();
  makeAgent(COLONIST);
  makeAgent(QE);
  makeAgent(IMPOSTOR);
});

describe("the honest record", () => {
  it("passes both halves: chain and attribution", () => {
    const rows = honestChain();
    expect(() => verifyActionChain(rows)).not.toThrow();
    expect(() => verifyActionAttribution(rows, keys as KeyRegistry)).not.toThrow();
  });
});

describe("AC 1 — a principal claim not signed by that principal's archived key fails", () => {
  // MUTATION-SENSITIVE: verify on the claimed principal alone and this stays
  // green for a commit anyone at all produced.
  it("rejects an entry signed by the impostor's key but naming another agent", () => {
    const rows = honestChain();
    // The impostor authors an act and writes COLONIST into the principal
    // field — trailer-style self-description, byte-plausible.
    const forged: ActionEntry = {
      commitmentId: "cmt-4",
      principal: COLONIST,
      kind: "land-code",
      commitSha: "c".repeat(40),
      ref: "Agent-Kax#347",
    };
    const head = rows[rows.length - 1].entryHash;
    const row: SignedActionRow = {
      ...forged,
      seq: 4,
      prevHash: head,
      entryHash: computeActionHash(head, 4, forged),
      signature: signAction(head, 4, forged, privs.get(IMPOSTOR)!),
    };
    const all = [...rows, row];
    // The chain half accepts it — hashes are all consistent.
    expect(() => verifyActionChain(all)).not.toThrow();
    // The identity half refuses: COLONIST's archived key disowns the bytes.
    expect(() => verifyActionAttribution(all, keys as KeyRegistry)).toThrow(/seq 4.*archived key/s);
  });

  it("rejects a principal with no archived key at all, rather than skipping it", () => {
    const rows = honestChain();
    const ghost: ActionEntry = {
      commitmentId: "cmt-5",
      principal: "kax:agent:never-registered",
      kind: "write-code",
      commitSha: "d".repeat(40),
      ref: null,
    };
    const head = rows[rows.length - 1].entryHash;
    const row = buildSignedAction(head, 4, ghost, privs.get(IMPOSTOR)!);
    expect(() => verifyActionAttribution([...rows, row], keys as KeyRegistry)).toThrow(
      /no archived key/,
    );
  });
});

describe("AC 2 — the reseal: rewrite a principal, rebuild every hash, chain passes, attribution fails", () => {
  // MUTATION-SENSITIVE: this is the demonstration from the #343 Hunt pass,
  // landed as a test. Remove the signature check and this goes red, because
  // the resealed chain is internally perfect.
  it("catches a reattributed entry that a chain audit cannot see", () => {
    const rows = honestChain();
    // The forger reattributes entry 1 — ColonistOne's write-code becomes the
    // impostor's — and reseals so every prevHash and entryHash agrees.
    rows[0] = { ...rows[0], principal: IMPOSTOR };
    const resealed = reseal(rows);

    // Corroboration half: PERFECT. This assertion is the finding — an audit
    // that stops here calls the forged record intact.
    expect(() => verifyActionChain(resealed)).not.toThrow();

    // Identity half: entry 1's signature was computed by COLONIST over bytes
    // naming COLONIST at the original chain position. The resealed entry
    // names IMPOSTOR, so the payload differs, and the key archived for
    // IMPOSTOR never signed anything here at all.
    expect(() => verifyActionAttribution(resealed, keys as KeyRegistry)).toThrow(/seq 1/);
  });

  it("catches the downstream entries too, because signatures bind chain position", () => {
    const rows = honestChain();
    rows[0] = { ...rows[0], principal: IMPOSTOR };
    const resealed = reseal(rows);
    // Every entry after the forgery now sits at a different prevHash than the
    // one its signature covered. Truncate to entries 2..n with entry 1
    // removed from scrutiny: they STILL fail, so a forger cannot even keep
    // the honest tail — the whole record downstream of the edit is disowned.
    const tail = resealed.slice(1);
    expect(() => verifyActionAttribution(tail, keys as KeyRegistry)).toThrow(/seq 2/);
  });
});

describe("F1 (#352 review) — seq is inside the signed bytes, so a renumbered row is caught", () => {
  // Before this fix, seq was the one field neither the hash nor the signature
  // covered — a store-writer could renumber rows and every audit error
  // ("attribution failed at seq N") would point a forensic reader at the
  // wrong row while both verifiers stayed green. Now the hash recomputation
  // uses the row's own seq, so a renumbered label breaks the chain half.
  it("rejects a chain whose rows were relabeled but otherwise untouched", () => {
    const rows = honestChain();
    const relabeled = [
      { ...rows[0], seq: 7 }, // hashes and signatures byte-identical
      rows[1],
      rows[2],
    ];
    expect(() => verifyActionChain(relabeled)).toThrow(/seq 7.*entryHash mismatch/s);
    expect(() => verifyActionAttribution(relabeled, keys as KeyRegistry)).toThrow(/seq 7/);
  });

  it("still accepts the honest numbering", () => {
    const rows = honestChain();
    expect(() => verifyActionChain(rows)).not.toThrow();
    expect(() => verifyActionAttribution(rows, keys as KeyRegistry)).not.toThrow();
  });
});

describe("AC 3 — verification reads the archived key, never the trailer's claim", () => {
  it("rejects a swapped principal even when the signature bytes are untouched", () => {
    const rows = honestChain();
    // Take QE's honestly-signed entry and change only the claimed principal.
    // The signature is real — QE truly made it — but it covers bytes naming
    // QE, so under COLONIST's archived key it must fail.
    const doctored = { ...rows[2], principal: COLONIST };
    // Keep the hash consistent so only attribution is under test.
    doctored.entryHash = computeActionHash(doctored.prevHash, doctored.seq, {
      commitmentId: doctored.commitmentId,
      principal: doctored.principal,
      kind: doctored.kind,
      commitSha: doctored.commitSha,
      ref: doctored.ref,
    });
    const all = [rows[0], rows[1], doctored];
    expect(() => verifyActionChain(all)).not.toThrow();
    expect(() => verifyActionAttribution(all, keys as KeyRegistry)).toThrow(/seq 3/);
  });
});

describe("trailers", () => {
  it("round-trips the three-line block", () => {
    const t = { commitmentId: "cmt-9", principal: QE, signature: "c2ln" };
    const msg = `feat: honest work\n\n${formatTrailers(t)}\n`;
    expect(parseTrailers(msg)).toEqual(t);
  });

  it("parses a doubled KAX-Principal as unattributed — ambiguity is not attribution (F2)", () => {
    // The message-appending forger's shape: the honest block is present and a
    // second principal line is appended below it. Git's last-wins convention
    // would hand the forger the parse; this parser refuses instead.
    const honest = { commitmentId: "cmt-9", principal: QE, signature: "c2ln" };
    const msg = `feat: honest work

${formatTrailers(honest)}
KAX-Principal: ${COLONIST}
`;
    expect(parseTrailers(msg)).toBeNull();
  });

  it("refuses a case-variant duplicate the way git's own trailer reader would see it", () => {
    // git interpret-trailers folds key case; this parser must not disagree
    // with it about how many principals a message carries. An appended
    // lowercase `kax-principal:` used to be ignored (honest values parsed);
    // now it collides and voids the parse. Exact case is still required to
    // ACCEPT a value, so a case-variant line can only void, never win.
    const honest = { commitmentId: "cmt-9", principal: QE, signature: "c2ln" };
    const msg = `feat: x\n\n${formatTrailers(honest)}\nkax-principal: ${COLONIST}\n`;
    expect(parseTrailers(msg)).toBeNull();
  });

  it("parses a principal with no signature as unattributed, not as partial", () => {
    // A commit carrying KAX-Principal without KAX-Signature is the exact
    // unfalsifiable shape #348 retires. It must not parse as attribution.
    const msg = "fix: thing\n\nKAX-Commitment: cmt-1\nKAX-Principal: " + QE + "\n";
    expect(parseTrailers(msg)).toBeNull();
  });
});
