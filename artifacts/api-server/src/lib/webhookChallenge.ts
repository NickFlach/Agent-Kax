/**
 * Proving we own the endpoint.
 *
 * Vincent's words: "A new subscription now starts as pending and receives
 * nothing until you prove you own the endpoint. We POST a signed challenge to
 * your URL; you echo the challenge string back (raw or as JSON), and the
 * subscription flips to active."
 *
 * That sentence names the wire format loosely on both sides, and we get ONE
 * SHOT at the live test — a subscription cannot leave `pending` if the echo is
 * wrong, and the signing secret is shown exactly once at create time, so a
 * failed verification is expensive to retry. A field-name mismatch is by far
 * the likeliest way to lose it. So this module is deliberately liberal in what
 * it accepts and deliberately loud about what actually arrived.
 *
 * WHAT IS ACCEPTED, in order:
 *   1. A body that is not JSON at all — the raw challenge string, whole.
 *   2. A JSON string literal — `"abc123"`.
 *   3. A JSON object carrying the challenge under any of a list of plausible
 *      names, at the top level or nested one level under `data` / `payload` /
 *      `subscription` / `verification` / `challenge`.
 *   4. Failing all of that, an `x-openbotcity-challenge` /
 *      `x-openclawcity-challenge` header.
 *
 * WHAT IS NOT: an ordinary event. The discriminator is written so a real
 * delivery can never be mistaken for a challenge — see `isChallengeShaped`.
 *
 * WHY MIRRORING THE REQUEST SHAPE IS THE ANSWER TO "raw or as JSON": both are
 * declared acceptable to the verifier, so either would do; replying in the same
 * shape the challenge arrived in is the one choice that needs no guess about
 * which their checker tries first. The challenge value also goes back in a
 * response header, which costs nothing and is a third place for a lenient
 * verifier to find it.
 */

/**
 * Field names checked for the challenge value.
 *
 * Ordered by how likely each is to be the real one, because the first match
 * wins and the ordering is the only thing that decides between two present
 * fields. `token` and `code` are last: they are the most likely to appear on a
 * normal event for an unrelated reason, so they are only consulted when
 * nothing more specific is there.
 */
export const CHALLENGE_FIELDS = [
  "challenge",
  "challenge_string",
  "challengeString",
  "challenge_token",
  "challengeToken",
  "challenge_value",
  "verification_string",
  "verificationString",
  "verification_token",
  "verificationToken",
  "verification",
  "nonce",
  "token",
  "code",
  "value",
] as const;

/** Containers a challenge might be nested one level inside. */
const CHALLENGE_CONTAINERS = ["data", "payload", "subscription", "verification", "challenge"];

/**
 * Event-type values that positively announce a challenge.
 *
 * NARROW ON PURPOSE, and the near-miss is worth naming because it would have
 * been a live-test-losing bug: an earlier draft matched /verif/, which matches
 * `verification.revoked` — the single most important event on the new
 * subscription. A revocation whose payload happened to carry a `code` or
 * `token` field would then have been echoed back as a challenge and never
 * applied, and rule six would have failed silently on the one delivery it
 * exists for. So a declared type announces a challenge only when it says
 * "challenge", or when it is scoped to the SUBSCRIPTION / WEBHOOK / ENDPOINT
 * rather than to a bot or a verification.
 */
const CHALLENGE_TYPE_RE = /(challenge|^(subscription|webhook|endpoint)[._-])/i;

/**
 * Fields whose NAME alone is strong evidence, whatever the declared type says.
 *
 * The safety net for the case this module cannot predict: a challenge that
 * arrives under a type nobody guessed. A field literally called `challenge`
 * is not something an ordinary event carries.
 */
const STRONG_FIELD_RE = /^(challenge|verification_(string|token)|verificationtoken)/i;

/**
 * Types that are definitely events, so definitely not challenges — the five
 * already handled plus the three arriving on the new subscription.
 *
 * This list is what lets the strong-field rule above be liberal without risk:
 * a real event is never echoed even if its payload happens to carry a field
 * with a challenge-ish name.
 */
const KNOWN_EVENT_TYPES = new Set([
  "artifact.created",
  "reaction.received",
  "proposal.created",
  "dm.received",
  "match.completed",
  "verification.revoked",
  "bot.created",
  "bot.verified",
]);

/** Where a recognised event carries its type. */
const EVENT_TYPE_FIELDS = ["event_type", "event", "type"];

export interface DetectedChallenge {
  challenge: string;
  /** How the body arrived, for the log line and for the reply shape. */
  bodyShape: "raw" | "json-string" | "json-object" | "header";
  /** Which field name carried it — the single most useful diagnostic. */
  field: string | null;
  /** The container it was nested in, if any. */
  container: string | null;
}

/** A trimmed, non-empty, plausibly-a-challenge string, or null. */
function asChallenge(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  // A bounded token. Anything longer is a document, not a nonce, and echoing
  // an arbitrary blob back to a caller who chose it is the open-oracle shape
  // this module must not become.
  if (!s || s.length > 512) return null;
  return s;
}

function pickField(obj: Record<string, unknown>): { field: string; value: string } | null {
  for (const f of CHALLENGE_FIELDS) {
    const v = asChallenge(obj[f]);
    if (v !== null) return { field: f, value: v };
  }
  return null;
}

/** Is any key in this object (or one level down) strongly challenge-named? */
function hasStrongChallengeField(obj: Record<string, unknown>): boolean {
  for (const k of Object.keys(obj)) {
    if (STRONG_FIELD_RE.test(k) && asChallenge(obj[k]) !== null) return true;
  }
  for (const c of CHALLENGE_CONTAINERS) {
    const inner = obj[c];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      for (const k of Object.keys(inner as Record<string, unknown>)) {
        if (STRONG_FIELD_RE.test(k) && asChallenge((inner as Record<string, unknown>)[k]) !== null) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Could this parsed JSON object be a challenge rather than an event?
 *
 * Decided in this order, and the order is the design:
 *
 *   1. A KNOWN event type is an event, always. This is what makes rule 3 safe.
 *   2. A declared type that says "challenge", or that is scoped to the
 *      subscription / webhook / endpoint, is a challenge.
 *   3. A field literally named `challenge` (or `verification_token`, …) is a
 *      challenge whatever else the body says — the net for a challenge whose
 *      type nobody guessed, which is the failure mode that costs the live test.
 *   4. Any other declared type is an event, and is left to fail as one rather
 *      than be echoed. A body we cannot classify must not become an oracle.
 *   5. No declared type and no event payload: a challenge candidate. Every
 *      genuine partner delivery names its type — the route 400s one that does
 *      not — so an untyped body is not an event that went wrong.
 */
export function isChallengeShaped(obj: Record<string, unknown>): boolean {
  const declared = EVENT_TYPE_FIELDS.map((f) => obj[f]).find((v) => typeof v === "string" && v);
  if (typeof declared === "string") {
    if (KNOWN_EVENT_TYPES.has(declared.trim().toLowerCase())) return false;
    if (CHALLENGE_TYPE_RE.test(declared)) return true;
    return hasStrongChallengeField(obj);
  }
  // No declared type. An event uuid plus a data/artifact payload still looks
  // like a (malformed) event, and should be allowed to fail as one rather than
  // be echoed.
  const looksLikeEvent =
    ("event_uuid" in obj || "id" in obj) && ("data" in obj || "payload" in obj || "artifact" in obj);
  if (looksLikeEvent) return hasStrongChallengeField(obj);
  return true;
}

/**
 * Find a challenge in a delivery, or return null if this is an ordinary event.
 *
 * `rawBody` must be the untouched bytes — the same buffer the signature was
 * checked against. Callers MUST verify that signature first: an endpoint that
 * echoes an attacker-chosen string on demand is an oracle, and the only thing
 * standing between this function and that is the HMAC.
 */
export function detectChallenge(
  rawBody: Buffer,
  headerChallenge?: string | undefined,
): DetectedChallenge | null {
  const text = rawBody.toString("utf8").trim();

  if (text) {
    let parsed: unknown;
    let isJson = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      isJson = false;
    }

    if (!isJson) {
      // Not JSON. It cannot be an event — the route parses events as JSON — so
      // the whole body is the challenge string, with surrounding quotes
      // stripped in case the sender wrapped it.
      const v = asChallenge(text.replace(/^"(.*)"$/s, "$1"));
      if (v !== null) return { challenge: v, bodyShape: "raw", field: null, container: null };
    } else if (typeof parsed === "string") {
      const v = asChallenge(parsed);
      if (v !== null) {
        return { challenge: v, bodyShape: "json-string", field: null, container: null };
      }
    } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (isChallengeShaped(obj)) {
        const top = pickField(obj);
        if (top) {
          return {
            challenge: top.value,
            bodyShape: "json-object",
            field: top.field,
            container: null,
          };
        }
        for (const c of CHALLENGE_CONTAINERS) {
          const inner = obj[c];
          // `{"challenge": "abc"}` is caught above; `{"challenge": {...}}`
          // lands here, which is why `challenge` is both a field and a
          // container name.
          if (inner && typeof inner === "object" && !Array.isArray(inner)) {
            const hit = pickField(inner as Record<string, unknown>);
            if (hit) {
              return {
                challenge: hit.value,
                bodyShape: "json-object",
                field: hit.field,
                container: c,
              };
            }
          }
        }
      }
    }
  }

  // Last resort: the vendor header. Only reached when the body carried nothing
  // usable, so it cannot hijack a real event.
  const h = asChallenge(headerChallenge);
  if (h !== null) return { challenge: h, bodyShape: "header", field: null, container: null };

  return null;
}
