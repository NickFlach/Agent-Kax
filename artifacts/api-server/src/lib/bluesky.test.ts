/**
 * bluesky.test.ts — the proof is public, so the proof is also the advert.
 *
 * Two properties matter and they pull against each other. The post has to read
 * like something a person would want to publish, and the nonce inside it has
 * to stay exactly machine-checkable — because the moment prose can blur the
 * token, an unproven account can be made to look proven.
 *
 * The third property is about manners rather than security: we compose, we
 * never publish. Nothing here posts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeAnnouncement,
  linkNonce,
  findNoncePost,
  resolveHandle,
  BlueskyError,
  HANDLE_RE,
  MAX_POST_LENGTH,
} from "./bluesky";

const DID = "did:plc:rrqtbsic7jzufwr5yk73ilj2";
const HANDLE = "flaukowski.bsky.social";
const NONCE = linkNonce("a1b2c3d4e5");

/** Stub the two public endpoints this module uses. */
function stubBluesky(opts: { did?: string | null; posts?: Array<{ text: string; authorDid?: string }> ; fail?: boolean }) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (opts.fail) throw new Error("ECONNREFUSED");
    const u = String(url);
    if (u.includes("resolveHandle")) {
      if (!opts.did) return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ did: opts.did }) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        feed: (opts.posts ?? []).map((p, i) => ({
          post: {
            uri: `at://${p.authorDid ?? DID}/app.bsky.feed.post/${i}`,
            author: { did: p.authorDid ?? DID },
            record: { text: p.text, createdAt: "2026-08-15T00:00:00Z" },
          },
        })),
      }),
    } as unknown as Response;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("the announcement", () => {
  it("carries the nonce verbatim and fits a Bluesky post", () => {
    const post = composeAnnouncement({ agentName: "Kannaka", nonce: NONCE });
    expect(post).toContain(NONCE);
    expect(post.length).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("stays inside the cap even for an absurd agent name", () => {
    const post = composeAnnouncement({ agentName: "A".repeat(200), nonce: NONCE });
    expect(post.length).toBeLessThanOrEqual(MAX_POST_LENGTH);
    expect(post).toContain(NONCE);
  });

  it("reads like an announcement, not a captcha", () => {
    // The whole reason to compose rather than emit a bare code: somebody has
    // to publish this to their followers.
    const post = composeAnnouncement({ agentName: "Kannaka", nonce: NONCE });
    expect(post).toMatch(/KAX City/);
    expect(post).toMatch(/kax\.ninja-portal\.com/);
    expect(post.split("\n").length).toBeGreaterThan(1);
  });

  it("namespaces the nonce so it cannot be mistaken for ordinary text", () => {
    expect(linkNonce("abc")).toBe("KAX-LINK-ABC");
  });
});

describe("finding the proof", () => {
  it("accepts a post from the handle's own DID", async () => {
    stubBluesky({ did: DID, posts: [{ text: `moving in\n\n${NONCE}` }] });
    const found = await findNoncePost(HANDLE, NONCE);
    expect(found).not.toBeNull();
    expect(found!.text).toContain(NONCE);
  });

  it("finds it among other posts", async () => {
    stubBluesky({ did: DID, posts: [{ text: "unrelated" }, { text: `hello ${NONCE} there` }] });
    expect(await findNoncePost(HANDLE, NONCE)).not.toBeNull();
  });

  it("refuses when the nonce is absent", async () => {
    stubBluesky({ did: DID, posts: [{ text: "moving into KAX City!" }] });
    expect(await findNoncePost(HANDLE, NONCE)).toBeNull();
  });

  it("refuses a near-miss nonce", async () => {
    stubBluesky({ did: DID, posts: [{ text: `${NONCE.slice(0, -1)}X` }] });
    expect(await findNoncePost(HANDLE, NONCE)).toBeNull();
  });

  it("ignores a post carried into the feed by another author", async () => {
    // A repost surfaces somebody else's words in this feed. Quoting the nonce
    // must never prove control of the account that quoted it.
    stubBluesky({ did: DID, posts: [{ text: NONCE, authorDid: "did:plc:someone-else" }] });
    expect(await findNoncePost(HANDLE, NONCE)).toBeNull();
  });

  it("reports an unknown handle as not-found", async () => {
    stubBluesky({ did: null });
    await expect(findNoncePost(HANDLE, NONCE)).rejects.toThrow(BlueskyError);
  });

  it("reports unreachable as UNKNOWN, not as unproven", async () => {
    // The distinction matters: "we could not check" must not be reported to a
    // user as "you failed to prove it", and must leave the challenge live.
    stubBluesky({ fail: true });
    await expect(resolveHandle(HANDLE)).rejects.toMatchObject({ status: 503 });
  });

  it("rejects things that are not handles before calling out", async () => {
    for (const bad of ["nodot", "", "-leading.dash", "has space.social"]) {
      expect(HANDLE_RE.test(bad), `accepted "${bad}"`).toBe(false);
    }
    expect(HANDLE_RE.test(HANDLE)).toBe(true);
  });
});
