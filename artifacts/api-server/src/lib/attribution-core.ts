import crypto, { type KeyObject } from "node:crypto";

/**
 * Pure, DB-free core of the signed autonomous-action record (issue #348,
 * KAX-ADR-0003 D5). Mirrors ledger-core.ts: the security-critical invariants
 * live here so they can be tested without a database, and a persistence layer
 * wraps them later.
 *
 * The problem this module exists to close, stated once so the shape of the
 * code makes sense:
 *
 * A hash chain proves nobody edited the record IN PLACE. It cannot catch a
 * writer who rebuilds the chain, because a rebuilt chain is perfectly
 * self-consistent — every prevHash and every entryHash agrees, and the record
 * still lies about who acted. Chain integrity and attribution integrity are
 * DIFFERENT PROPERTIES, and ADR-0003's commit trailers
 * (`KAX-Principal: kax:agent:<bot_id>`) assert the second while the chain
 * defends only the first. A trailer is free text the committing process writes
 * about itself.
 *
 * So every entry here carries an Ed25519 signature by the acting agent's key
 * over three things at once: the entry's content, its chain position
 * (prevHash), and the principal it names. Binding the position means a forger
 * cannot lift an honest signature onto a rebuilt chain; binding the principal
 * means the signature IS the attribution rather than a decoration on it.
 * Verification resolves the public key from an ARCHIVED registry keyed by
 * principal — never from the entry, which would be asking the claim to vouch
 * for itself.
 *
 * Identity says who, corroboration proves what. verifyActionChain() is the
 * corroboration half; verifyActionAttribution() is the identity half; accept
 * an action record only when both pass.
 */

// The chain's genesis: the prevHash of the very first action entry.
export const ACTION_GENESIS_HASH = "GENESIS::action-record::v1";

/**
 * One autonomous act, as recorded. `commitmentId` is the idempotency key
 * (ADR-0003 D5: a retried executor must not double-act), `principal` is the
 * actor in the same `kax:agent:<bot_id>` spelling everything else uses, and
 * `commitSha` binds the record to the git object the act produced, so the
 * record and the commit are attested together rather than merely adjacent.
 */
export interface ActionEntry {
  commitmentId: string;
  principal: string;
  kind: string; // read-code | write-code | review-code | land-code | meet
  commitSha: string | null; // null for kinds that produce no commit
  ref?: string | null; // free-form context: repo, PR url, room
}

export interface SignedActionRow extends ActionEntry {
  seq: number;
  prevHash: string;
  entryHash: string;
  /** Ed25519 signature, base64, by the key archived for `principal`. */
  signature: string;
}

/**
 * Canonical byte serialization of the fields an entry commits to. Field order
 * is fixed and explicit for the same reason as ledger-core: the hash must be
 * stable and language-agnostic, so object key order can never matter.
 *
 * `seq` is IN the canonical form, deliberately diverging from ledger-core.
 * There the label is inert; here every audit error dereferences it
 * ("attribution failed at seq 4"), which makes it the entry point a forensic
 * reader follows into the store. An unauthenticated forensic pointer is the
 * one field a store-writer could renumber without tripping either verifier,
 * leaving every audit message pointing at the wrong row (#352 review, F1).
 * Binding it costs one array slot now, and would have cost a chain-format
 * migration the day after the first row persisted.
 */
function canonical(prevHash: string, seq: number, e: ActionEntry): string {
  return JSON.stringify([
    prevHash,
    seq,
    e.commitmentId,
    e.principal,
    e.kind,
    e.commitSha,
    e.ref ?? null,
  ]);
}

export function computeActionHash(prevHash: string, seq: number, e: ActionEntry): string {
  return crypto.createHash("sha256").update(canonical(prevHash, seq, e)).digest("hex");
}

/**
 * The bytes the agent signs. Deliberately the same canonical string the hash
 * covers — which already includes prevHash and principal — so one signature
 * binds content, chain position, and claimed actor in a single operation.
 * Signing only the entryHash would be weaker in a way that matters here: a
 * hash proves the signer saw SOME bytes with that digest, while signing the
 * canonical form proves the signer saw THESE fields, including the principal
 * being asserted.
 */
export function signingPayload(prevHash: string, seq: number, e: ActionEntry): Buffer {
  return Buffer.from(canonical(prevHash, seq, e), "utf8");
}

export function signAction(
  prevHash: string,
  seq: number,
  e: ActionEntry,
  privateKey: KeyObject,
): string {
  // Ed25519 is single-shot in node:crypto: algorithm is null, no digest choice
  // to get wrong. Same primitive identity.ts mints tokens with.
  return crypto.sign(null, signingPayload(prevHash, seq, e), privateKey).toString("base64");
}

/**
 * The archived key registry: principal -> Ed25519 public key. The registry is
 * an input rather than a lookup this module performs, so the core stays
 * DB-free — but the CONTRACT is that it is populated from key material
 * archived at grant time (ADR-0001's shape), never from anything the entry
 * itself carries.
 */
export type KeyRegistry = ReadonlyMap<string, KeyObject>;

/**
 * Corroboration half: recompute the whole chain from genesis and confirm every
 * link and hash. Returns the verified head. Throws at the first broken link.
 *
 * NOTE what this does NOT check: signatures. That is the point of the split —
 * the reseal test in attribution-core.test.ts constructs a chain that passes
 * this function while lying about authorship, which is the exact failure
 * issue #348 exists to make impossible to miss.
 */
export function verifyActionChain(rows: SignedActionRow[]): string {
  let prev = ACTION_GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev) {
      throw new Error(`action chain link broken at seq ${r.seq}: prevHash mismatch`);
    }
    const h = computeActionHash(prev, r.seq, {
      commitmentId: r.commitmentId,
      principal: r.principal,
      kind: r.kind,
      commitSha: r.commitSha,
      ref: r.ref,
    });
    if (h !== r.entryHash) {
      throw new Error(`action chain hash broken at seq ${r.seq}: entryHash mismatch`);
    }
    prev = h;
  }
  return prev;
}

/**
 * Identity half: every entry's signature must verify against the key ARCHIVED
 * for the principal the entry names. Throws naming the seq and principal on
 * the first failure.
 *
 * Two refusals are deliberate and load-bearing:
 *
 * - A principal with no archived key FAILS. Treating an unknown principal as
 *   unverifiable-therefore-skipped would let a forger evade the check by
 *   attributing acts to a principal nobody registered — absence of a key is
 *   absence of attribution, not a pass.
 * - The key is resolved from the registry by the principal STRING THE ENTRY
 *   CLAIMS. That is safe precisely because the claimed principal is inside the
 *   signed payload: name a different principal and the signature that exists
 *   was computed over different bytes, so verification fails. The claim cannot
 *   vouch for itself; it can only nominate which archived key must disown it.
 */
export function verifyActionAttribution(rows: SignedActionRow[], keys: KeyRegistry): void {
  for (const r of rows) {
    const key = keys.get(r.principal);
    if (!key) {
      throw new Error(
        `attribution failed at seq ${r.seq}: no archived key for principal '${r.principal}'`,
      );
    }
    const payload = signingPayload(r.prevHash, r.seq, {
      commitmentId: r.commitmentId,
      principal: r.principal,
      kind: r.kind,
      commitSha: r.commitSha,
      ref: r.ref,
    });
    const ok = crypto.verify(null, payload, key, Buffer.from(r.signature, "base64"));
    if (!ok) {
      throw new Error(
        `attribution failed at seq ${r.seq}: signature does not verify against the archived key ` +
          `for principal '${r.principal}'`,
      );
    }
  }
}

/**
 * Build the next signed row. Pure — the caller persists it atomically, and
 * per ADR-0003 D5 must persist it WRITE-AHEAD of the act it records: written
 * after, a crash between act and record is an unrecorded action, the silent
 * failure D8 forbids.
 */
export function buildSignedAction(
  headHash: string,
  seq: number,
  e: ActionEntry,
  privateKey: KeyObject,
): SignedActionRow {
  const entryHash = computeActionHash(headHash, seq, e);
  const signature = signAction(headHash, seq, e, privateKey);
  return { ...e, seq, prevHash: headHash, entryHash, signature };
}

// ---------------------------------------------------------------------------
// Commit trailers (ADR-0003 D5). The trailer block gains a KAX-Signature line
// so the commit itself carries the same attestation the record does. The
// signature in the trailer covers the action's canonical payload — NOT the
// commit object — so it can be written before push and checked against the
// record afterwards; commitSha in the signed record is what ties the two
// together.
// ---------------------------------------------------------------------------

const TRAILER_KEYS = ["KAX-Commitment", "KAX-Principal", "KAX-Signature"] as const;

export interface AttributionTrailers {
  commitmentId: string;
  principal: string;
  signature: string;
}

export function formatTrailers(t: AttributionTrailers): string {
  return [
    `KAX-Commitment: ${t.commitmentId}`,
    `KAX-Principal: ${t.principal}`,
    `KAX-Signature: ${t.signature}`,
  ].join("\n");
}

/**
 * Parse the KAX trailers out of a commit message. Returns null when any of the
 * three is missing — a commit with a principal and no signature is exactly the
 * unfalsifiable shape this module exists to retire, so it parses as
 * unattributed rather than as partially attributed.
 *
 * Duplicated keys also parse as null. Git convention is last-wins, but a
 * doubled `KAX-Principal:` is exactly what a message-appending forger
 * produces — the honest block already present, a second principal line added
 * below it — and last-wins hands that forger the parse (#352 review, F2). The
 * signature cross-check would catch the lie later; the parser still must not
 * return a confident wrong answer in the meantime. Ambiguous attribution is
 * no attribution.
 */
export function parseTrailers(message: string): AttributionTrailers | null {
  // Duplicate detection is case-INSENSITIVE while acceptance stays
  // case-EXACT. git interpret-trailers folds key case, so an appended
  // `kax-principal:` that this parser merely ignored would read as a second
  // principal to anyone using git's own machinery — two readers of the same
  // bytes disagreeing about attribution, the defect class this module exists
  // for (#354 review, 0xSCADA-QE). Folding the collision check closes the
  // ignored-line channel; requiring exact case for acceptance means a
  // case-variant line can only ever void a parse, never win it.
  const found = new Map<string, string>();
  const seenFold = new Set<string>();
  const KEYS_FOLD = new Set((TRAILER_KEYS as readonly string[]).map((k) => k.toLowerCase()));
  for (const line of message.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const fold = m[1].toLowerCase();
    if (!KEYS_FOLD.has(fold)) continue;
    if (seenFold.has(fold)) return null;
    seenFold.add(fold);
    if ((TRAILER_KEYS as readonly string[]).includes(m[1])) {
      found.set(m[1], m[2].trim());
    }
  }
  const commitmentId = found.get("KAX-Commitment");
  const principal = found.get("KAX-Principal");
  const signature = found.get("KAX-Signature");
  if (!commitmentId || !principal || !signature) return null;
  return { commitmentId, principal, signature };
}
