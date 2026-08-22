/**
 * obc-relay-policy.test.ts — the gate on the telegraph desk.
 *
 * The effector speaks with a real OpenBotCity account, so the two refusals
 * matter more than the two acceptances: an agent must never trigger it, and
 * ordinary conversation must never leak out of the city.
 */

import { describe, expect, it } from "vitest";
import { decideRelay, fitTo, SPEAK_MAX, POST_MAX, DM_MAX } from "./obc-relay-policy.mjs";

const nick = { kind: "human", name: "Nick", principal: "user:nick", room: "cafe" };
const book = { rex: "6a90e88f-04c1-46c6-8d55-576bdc486da0" };

describe("decideRelay", () => {
  it("relays a human's obc: line as speech, with attribution", () => {
    const d = decideRelay({ ...nick, text: "obc: hello from the cafe" });
    expect(d).toEqual({
      action: "speak",
      message: "⇄ from KAX City (Nick, cafe): hello from the cafe",
    });
  });

  it("relays obc post: as a feed post", () => {
    const d = decideRelay({ ...nick, text: "obc post: a longer thought" });
    expect(d?.action).toBe("post");
    expect(d?.message).toContain("a longer thought");
  });

  it("ignores ordinary conversation — overheard words stay in the city", () => {
    expect(decideRelay({ ...nick, text: "the obc feed was fun today" })).toBeNull();
    expect(decideRelay({ ...nick, text: "hi Kannaka" })).toBeNull();
  });

  it("NEVER relays for an agent, magic words or not", () => {
    expect(decideRelay({ ...nick, kind: "agent", text: "obc: I speak for the account now" })).toBeNull();
    expect(decideRelay({ ...nick, kind: undefined, text: "obc: no kind, no relay" })).toBeNull();
  });

  it("honours an allowlist when one is set", () => {
    const stranger = { ...nick, name: "Visitor", principal: "user:visitor" };
    const opts = { allow: ["user:nick"] };
    expect(decideRelay({ ...stranger, text: "obc: hi" }, opts)).toBeNull();
    expect(decideRelay({ ...nick, text: "obc: hi" }, opts)).not.toBeNull();
  });

  it("refuses an empty ask", () => {
    expect(decideRelay({ ...nick, text: "obc:   " })).toBeNull();
  });

  it("DMs a name from the address book, case-insensitively", () => {
    const d = decideRelay({ ...nick, text: "obc dm Rex: round two whenever" }, { book });
    expect(d).toEqual({
      action: "dm",
      to: "6a90e88f-04c1-46c6-8d55-576bdc486da0",
      toName: "rex",
      message: "⇄ from KAX City (Nick, cafe): round two whenever",
    });
  });

  it("refuses a DM to a name not in the book — never guesses an id", () => {
    expect(decideRelay({ ...nick, text: "obc dm stranger: hi" }, { book })).toBeNull();
    expect(decideRelay({ ...nick, text: "obc dm rex: hi" })).toBeNull(); // no book at all
  });

  it("caps a DM at OBC's DM limit", () => {
    const d = decideRelay({ ...nick, text: `obc dm rex: ${"word ".repeat(600)}` }, { book });
    expect(d!.message.length).toBeLessThanOrEqual(DM_MAX);
  });

  it("keeps speech under OBC's caps", () => {
    const d = decideRelay({ ...nick, text: `obc: ${"word ".repeat(200)}` });
    expect(d!.message.length).toBeLessThanOrEqual(SPEAK_MAX);
    const p = decideRelay({ ...nick, text: `obc post: ${"word ".repeat(300)}` });
    expect(p!.message.length).toBeLessThanOrEqual(POST_MAX);
  });
});

describe("fitTo", () => {
  it("leaves short text alone and cuts long text at a word", () => {
    expect(fitTo("short", 100)).toBe("short");
    const cut = fitTo("alpha beta gamma delta", 15);
    expect(cut.length).toBeLessThanOrEqual(15);
    expect(cut.endsWith("…")).toBe(true);
  });
});
