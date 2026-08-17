/**
 * is-typing.test.ts — whose keystroke is it?
 *
 * The city binds bare letters to actions, so this one predicate decides whether
 * a key press walks the avatar or gets typed into something. Every keyboard
 * handler in the city reads it, which means a gap here is a gap in all of them
 * at once — and the gap is invisible on screen, because the visitor sees their
 * own text appearing while the world moves behind it.
 *
 * Behavioural rather than source-reading: the module has one exported function
 * and it is called with a focused element and returns a boolean, so there is
 * nothing to gain by inspecting it. `document` is a stub because the runner is
 * a Node environment by design (`vitest.config.ts` explains why) and the two
 * properties this function touches are the two the stub has.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isTypingTarget } from "./is-typing";

type FakeElement = { tagName: string; isContentEditable?: boolean };

const host = globalThis as { document?: unknown };

/** Put focus on something shaped like an element, or on nothing. */
function focus(activeElement: FakeElement | null): void {
  host.document = { activeElement };
}

afterEach(() => {
  delete host.document;
});

describe("isTypingTarget", () => {
  it("is true for every field a person types into", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      focus({ tagName });
      expect(isTypingTarget(), tagName).toBe(true);
    }
  });

  it("is true for a rich text field", () => {
    focus({ tagName: "DIV", isContentEditable: true });
    expect(isTypingTarget()).toBe(true);
  });

  it("is true when focus is inside an iframe", () => {
    // The case this file was written for. Focus inside a cross-origin frame
    // reports the IFRAME element itself and nothing about what is focused
    // within it, so the only honest reading is that the keystroke belongs to
    // content we do not own. Live today for the arcade's embedded games, and
    // load-bearing for the checkout desk: a Stripe 3D Secure challenge is a
    // cross-origin iframe, and a player entering a one-time passcode must not
    // walk out of the shop on the letters of it.
    focus({ tagName: "IFRAME" });
    expect(isTypingTarget()).toBe(true);
  });

  it("is false for the ordinary case, so the checks above mean something", () => {
    // Without this the predicate could return true unconditionally and every
    // assertion above would still pass — and the city would be unwalkable.
    focus({ tagName: "DIV" });
    expect(isTypingTarget()).toBe(false);

    focus({ tagName: "CANVAS" });
    expect(isTypingTarget()).toBe(false);

    // `isContentEditable: false` is the shape a real element has, and it must
    // not be read as truthy.
    focus({ tagName: "SPAN", isContentEditable: false });
    expect(isTypingTarget()).toBe(false);
  });

  it("is false when nothing is focused at all", () => {
    focus(null);
    expect(isTypingTarget()).toBe(false);
  });
});
