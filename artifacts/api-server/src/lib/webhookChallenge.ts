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
 *   1. A body that is not JSON at all — a form-encoded `challenge=abc123` if it
 *      is unambiguously that, otherwise the raw challenge string, whole.
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
 * AND THE HEADER IS TRULY LAST. Step 4 is reached only when the body could not
 * be classified as an event AT ALL. A body that classifies as an event returns
 * null from here immediately, before the header is ever read. That ordering is
 * a security property, not a nicety: the header sits OUTSIDE the HMAC, so
 * anything that can add one to an otherwise valid signed delivery could
 * otherwise cancel it — a real `verification.revoked` would be answered with an
 * echo and the freeze would never be applied. The header stays supported
 * because a challenge whose value arrives only in a header is a live-test-losing
 * shape we cannot rule out, but it can no longer speak over a body that already
 * said what it was.
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
 *
 * The narrowing has to cover the type WHEREVER IT WAS DECLARED. `webhooks.ts`
 * treats `x-openbotcity-event` as a legitimate type source — it is the fourth
 * fallback in the eventType chain — so a delivery may name itself only in that
 * header. Guarding the body-borne type alone left exactly the hole this comment
 * says was closed: a flat `verification.revoked` typed only in the header, with
 * a `code` or `token` in its payload, was echoed as a challenge and never
 * applied. So `isChallengeShaped` takes the header type too.
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
  bodyShape: "raw" | "form" | "json-string" | "json-object" | "header";
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

/**
 * A form-encoded body — `challenge=abc123` — unwrapped to just the value.
 *
 * `application/x-www-form-urlencoded` is the third thing a sender reaches for
 * after raw text and JSON, and it is the one shape where the old fallback was
 * actively WRONG rather than merely unhandled: the whole body was treated as
 * the challenge string, so `challenge=abc123` was echoed back verbatim, key and
 * all, and the verifier looking for `abc123` would not have found it.
 *
 * Deliberately strict, because the raw-string path must not be stolen from. A
 * bare challenge can itself contain `=` — base64 padding is the obvious case,
 * and `dGVzdA==` parses as form data with the key `dGVzdA`. So a body counts as
 * form-encoded only when one of its keys is a name we already recognise as
 * carrying a challenge. Nothing else is claimed.
 */
function pickFormField(text: string): { field: string; value: string } | null {
  if (!text.includes("=") || /[\r\n]/.test(text)) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(text);
  } catch {
    return null;
  }
  for (const f of CHALLENGE_FIELDS) {
    const v = asChallenge(params.get(f));
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
 * Could this delivery be a challenge rather than an event?
 *
 * `headerEventType` is the `x-openbotcity-event` / `x-openclawcity-event` value,
 * which the route already treats as a legitimate place for a delivery to name
 * its type. Passing it is not optional in practice: without it a flat
 * `verification.revoked` that declares itself only in the header is invisible
 * to every rule below, and the FIRST one — the rule that makes all the liberal
 * ones safe — is exactly the one that had to see it.
 *
 * Decided in this order, and the order is the design:
 *
 *   0. A KNOWN event type in the HEADER is an event, decisively, before
 *      anything else is consulted. The header is the only place some deliveries
 *      say what they are, and a payload field cannot argue with it.
 *   1. A KNOWN event type in the body is an event, always. This is what makes
 *      rule 3 safe.
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
 *
 * Rules 2-4 read the body-borne type when there is one and the header-borne
 * type otherwise, so a type declared in either place is judged the same way.
 */
export function isChallengeShaped(
  obj: Record<string, unknown>,
  headerEventType?: string | undefined,
): boolean {
  const fromHeader = typeof headerEventType === "string" ? headerEventType.trim() : "";
  if (fromHeader && KNOWN_EVENT_TYPES.has(fromHeader.toLowerCase())) return false;

  const fromBody = EVENT_TYPE_FIELDS.map((f) => obj[f]).find((v) => typeof v === "string" && v);
  const declared = typeof fromBody === "string" ? fromBody : fromHeader;
  if (declared) {
    if (KNOWN_EVENT_TYPES.has(declared.trim().toLowerCase())) return false;
    if (CHALLENGE_TYPE_RE.test(declared)) return true;
    return hasStrongChallengeField(obj);
  }
  // No declared type anywhere. An event uuid plus a data/artifact payload still
  // looks like a (malformed) event, and should be allowed to fail as one rather
  // than be echoed.
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
  headerEventType?: string | undefined,
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
      // the body is the challenge: form-encoded if it unambiguously is, and
      // otherwise the whole string, with surrounding quotes stripped in case
      // the sender wrapped it.
      const form = pickFormField(text);
      if (form) {
        return { challenge: form.value, bodyShape: "form", field: form.field, container: null };
      }
      const v = asChallenge(text.replace(/^"(.*)"$/s, "$1"));
      if (v !== null) return { challenge: v, bodyShape: "raw", field: null, container: null };
    } else if (typeof parsed === "string") {
      const v = asChallenge(parsed);
      if (v !== null) {
        return { challenge: v, bodyShape: "json-string", field: null, container: null };
      }
    } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      // CLASSIFIED AS AN EVENT — and that is final. Returning here rather than
      // falling through is the whole of the fix: the vendor header below is not
      // covered by the HMAC, so letting a delivery that already said "I am a
      // revocation" reach it meant one added header could answer 200 with an
      // echo and drop the freeze on the floor.
      if (!isChallengeShaped(obj, headerEventType)) return null;

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

  // Last resort: the vendor header, now genuinely last. Everything above either
  // returned a challenge or established that the body is not an event, so this
  // can no longer speak over a delivery that classified as one.
  const h = asChallenge(headerChallenge);
  if (h !== null) return { challenge: h, bodyShape: "header", field: null, container: null };

  return null;
}
