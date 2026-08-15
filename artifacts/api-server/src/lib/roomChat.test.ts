/**
 * roomChat.test.ts — speech has to carry a distance, or it is a broadcast.
 *
 * The whole point of proximity chat is that saying something in one corner of
 * the district does not arrive in every ear. These tests hold that line, plus
 * the two guards that keep a room habitable: a length limit and a rate limit.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { say, heard, _clear, ChatRefused, CHAT_RADIUS, MIN_GAP_MS, MAX_TEXT } from "./roomChat";

const near = { x: 0, z: 0 };

describe("room chat", () => {
  beforeEach(() => _clear());

  it("is heard nearby", () => {
    say({ principal: "a", name: "A", room: "city", text: "over here", x: 2, z: 2 });
    expect(heard("city", near).map((l) => l.text)).toEqual(["over here"]);
  });

  it("is NOT heard from across the district", () => {
    say({ principal: "a", name: "A", room: "city", text: "far away", x: CHAT_RADIUS + 10, z: 0 });
    expect(heard("city", near)).toEqual([]);
  });

  it("does not leak between rooms", () => {
    say({ principal: "a", name: "A", room: "cafe", text: "inside", x: 0, z: 0 });
    expect(heard("city", near)).toEqual([]);
    expect(heard("cafe", near)).toHaveLength(1);
  });

  it("only returns what the listener has not already heard", () => {
    const first = say({ principal: "a", name: "A", room: "city", text: "one", x: 0, z: 0 });
    say({ principal: "b", name: "B", room: "city", text: "two", x: 0, z: 0 });
    const after = heard("city", near, first.id);
    expect(after.map((l) => l.text)).toEqual(["two"]);
  });

  it("refuses a speaker who will not pause", () => {
    const t = 1_000_000;
    say({ principal: "a", name: "A", room: "city", text: "one", x: 0, z: 0 }, t);
    expect(() => say({ principal: "a", name: "A", room: "city", text: "two", x: 0, z: 0 }, t + 10))
      .toThrow(ChatRefused);
    // ...but lets them speak again once they have.
    expect(() => say({ principal: "a", name: "A", room: "city", text: "three", x: 0, z: 0 }, t + MIN_GAP_MS + 1))
      .not.toThrow();
  });

  it("refuses an essay and an empty line alike", () => {
    expect(() => say({ principal: "a", name: "A", room: "city", text: "x".repeat(MAX_TEXT + 1), x: 0, z: 0 }))
      .toThrow(ChatRefused);
    expect(() => say({ principal: "b", name: "B", room: "city", text: "   ", x: 0, z: 0 }))
      .toThrow(ChatRefused);
  });
});
