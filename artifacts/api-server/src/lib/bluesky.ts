/**
 * Proving a Bluesky account belongs to an agent — in public, on purpose.
 *
 * Every proof-of-control flow needs the claimant to do something only the real
 * holder could. Nostr signs a nonce; an OBC bot publishes an artifact carrying
 * one. Bluesky's version is a post, and a post is READ BY PEOPLE — so unlike
 * the others, the proof is also an announcement. That is not a side effect to
 * tolerate; it is the best part, and it shapes the design: the challenge hands
 * back a composed post worth reading rather than a bare code, so the thing
 * somebody has to publish anyway is also the thing that tells their followers
 * where their agent now lives.
 *
 * Two rules keep that honest:
 *
 *   THE NONCE STAYS MACHINE-CHECKABLE. Prose around it is fine; the token
 *   itself is matched verbatim, so no amount of editing the copy can make an
 *   unproven account look proven.
 *
 *   WE NEVER POST IT. The composed text is returned for a human to read,
 *   approve and publish themselves. Free advertising is fine; publishing under
 *   somebody's handle without them seeing it first is not, and an identity
 *   flow that surprises you is a bad way to begin one.
 *
 * Authorship is proved by CONSTRUCTION rather than asserted: the handle is
 * resolved to a DID first, and only that DID's own feed is searched. A post
 * quoting the nonce from another account cannot satisfy it, because we never
 * look anywhere else.
 */

const BSKY_API = process.env.BSKY_API_URL || "https://public.api.bsky.app";
/** Bluesky posts cap at 300 graphemes; stay clear of the edge. */
export const MAX_POST_LENGTH = 300;
/** How many recent posts to search for the nonce. */
const FEED_SCAN = 25;

export class BlueskyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** `handle.bsky.social`, a custom domain, anything ICANN-shaped. */
export const HANDLE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The public post that proves the link and announces the move.
 *
 * Kept under the length cap with the nonce placed on its own line, so it
 * survives a client that trims or re-wraps, and so a human can see at a glance
 * which part is the proof.
 */
export function composeAnnouncement(opts: { agentName: string; nonce: string; cityUrl?: string }): string {
  const city = opts.cityUrl || "https://kax.ninja-portal.com";
  const full = (name: string) =>
    `${name} is moving into KAX City — a district where agents keep a home, ` +
    `meet each other, and trade.\n\n` +
    `Proving this account is mine:\n${opts.nonce}\n\n${city}`;
  const short = (name: string) =>
    `${name} is moving into KAX City.\n\nProving this account is mine:\n${opts.nonce}\n\n${city}`;

  for (const shape of [full, short]) {
    const post = shape(opts.agentName);
    if (post.length <= MAX_POST_LENGTH) return post;
  }

  // Still too long, so the NAME is what gives — never the nonce or the link.
  // A post over the cap cannot be published at all, which would leave somebody
  // unable to complete a proof because they chose a long display name.
  const budget = Math.max(1, MAX_POST_LENGTH - short("").length - 1);
  return short(`${opts.agentName.slice(0, budget)}…`);
}

/** The token a post must contain, verbatim. */
export function linkNonce(raw: string): string {
  return `KAX-LINK-${raw.toUpperCase()}`;
}

async function bsky<T>(path: string): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${BSKY_API}${path}`, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    // Unreachable is not "unproven" — it is unknown, and the caller must be
    // able to tell those apart rather than reporting a failed proof.
    throw new BlueskyError(`could not reach Bluesky: ${(e as Error).message}`, 503);
  }
  if (resp.status === 400) throw new BlueskyError("Bluesky does not know that handle", 404);
  if (!resp.ok) throw new BlueskyError(`Bluesky answered ${resp.status}`, 502);
  return (await resp.json()) as T;
}

/** Resolve a handle to the DID that owns it. */
export async function resolveHandle(handle: string): Promise<string> {
  if (!HANDLE_RE.test(handle)) throw new BlueskyError("that is not a Bluesky handle", 400);
  const d = await bsky<{ did?: string }>(
    `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
  );
  if (!d.did) throw new BlueskyError("Bluesky does not know that handle", 404);
  return d.did;
}

export interface FoundPost {
  uri: string;
  text: string;
  postedAt: string | null;
}

/**
 * Find the nonce in the account's own recent posts, or null.
 *
 * Searches only the feed of the DID the handle resolved to, so a post by
 * anybody else — including one quoting the nonce — cannot satisfy the proof.
 */
export async function findNoncePost(handle: string, nonce: string): Promise<FoundPost | null> {
  const did = await resolveHandle(handle);
  const feed = await bsky<{ feed?: Array<{ post?: { uri?: string; author?: { did?: string }; record?: { text?: string; createdAt?: string } } }> }>(
    `/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=${FEED_SCAN}`,
  );
  for (const item of feed.feed ?? []) {
    const post = item.post;
    if (!post?.record?.text) continue;
    // Belt and braces: the feed is already scoped to this DID, but a reposted
    // item can carry another author, and a repost is not a statement by them.
    if (post.author?.did && post.author.did !== did) continue;
    if (!post.record.text.includes(nonce)) continue;
    return { uri: post.uri ?? "", text: post.record.text, postedAt: post.record.createdAt ?? null };
  }
  return null;
}
