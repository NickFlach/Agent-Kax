/**
 * artifactPublication.ts — is a partner artifact demonstrably NOT public?
 *
 * `POST /auth/agent/verify` tells the user to *publish* an OBC artifact
 * containing the challenge phrase, but only checked creator, phrase and
 * freshness — never that the artifact is actually visible to anyone. So the
 * proof could be satisfied by something no third party could ever see, which
 * is not the contract the UI describes. (#115)
 *
 * The deliberate design choice here is the direction of the check.
 *
 * We reject ONLY on positive evidence of non-publication, never on the absence
 * of a publication signal. The partner artifact payload is typed
 * `[k: string]: unknown` precisely because its shape is not pinned down on this
 * side, and OBC is free to omit or rename fields. A check that required proof
 * of publication would reject every legitimate user the moment the API stopped
 * sending a field we guessed at — locking people out of attaching their own
 * bots, which is a worse and much louder failure than the weakness it closes.
 *
 * So this narrows the hole without ever being able to block a genuine publish:
 * an artifact that SAYS it is private/draft/unlisted is refused; one that says
 * nothing is treated as before.
 */

/** Values that, when seen in a status/visibility field, mean "not public". */
const NON_PUBLIC_STATES = new Set([
  "private",
  "draft",
  "unlisted",
  "hidden",
  "unpublished",
  "deleted",
  "archived",
]);

/** Fields OBC might use to express visibility, checked defensively. */
const STATE_FIELDS = ["visibility", "status", "state", "publish_status", "publication_status"];

/** Booleans whose FALSE value means "not public". */
const TRUE_MEANS_PUBLIC = ["is_public", "public", "published", "is_published"];

export interface PublicationVerdict {
  /** True only when the artifact positively declares itself non-public. */
  nonPublic: boolean;
  /** The field that gave it away, for the error message and the log. */
  signal?: string;
}

/**
 * Inspect an artifact payload for a declared non-public state.
 *
 * Returns `{ nonPublic: false }` when nothing says otherwise — including for a
 * payload with no visibility information at all. That is the fail-open half,
 * and it is intentional; see the module note.
 */
export function detectNonPublic(artifact: unknown): PublicationVerdict {
  if (!artifact || typeof artifact !== "object") return { nonPublic: false };
  const a = artifact as Record<string, unknown>;

  for (const field of STATE_FIELDS) {
    const raw = a[field];
    if (typeof raw === "string" && NON_PUBLIC_STATES.has(raw.trim().toLowerCase())) {
      return { nonPublic: true, signal: `${field}="${raw}"` };
    }
  }

  for (const field of TRUE_MEANS_PUBLIC) {
    // Strictly `false` — `undefined`/missing must not count, or every payload
    // without the field would be rejected.
    if (a[field] === false) {
      return { nonPublic: true, signal: `${field}=false` };
    }
  }

  return { nonPublic: false };
}
