/**
 * store-interior.test.ts — the checkout desk, and the four ways a 3D shop
 * quietly gets a purchase wrong.
 *
 * Read as source rather than rendered, in the idiom of `purchase-panel.test.ts`
 * and `App.routes.test.ts` and for the same reason those are: the runner has no
 * DOM by design, and every property below is about the SHAPE of the page —
 * where a component is mounted relative to the `<Canvas>`, whether a collision
 * box exists for a thing that is drawn, whether an early return comes before
 * the code it is supposed to skip. Those are exactly the properties that
 * survive a render and are invisible in one: a desk you can walk through
 * screenshots identically to a desk you cannot.
 *
 * The four failures being guarded, none of which throws:
 *
 * 1. A desk that is drawn but not collided with. `FpsObstacle` is an AABB, so a
 *    rotated desk cannot be described honestly either.
 * 2. A panel mounted INSIDE the canvas, which typechecks, renders as nothing a
 *    screen reader can see and nothing a keyboard can reach.
 * 3. A rig that keeps walking during a bank challenge, which shows up as an
 *    avatar drifting away while somebody types a passcode.
 * 4. A drei `<Text>` with no Suspense boundary, which blanks the entire scene on
 *    a cold font fetch — a repeat offender in this repository.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARCADE_Z,
  DESK_OBSTACLE,
  DESK_POSITION,
  DESK_SPAWN,
  TALK_RANGE,
  storeObstacles,
  withinTalkRange,
} from "../lib/room-geometry";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/**
 * The file with its comments removed.
 *
 * Every rule below is about what the code DOES, and this page discusses desks,
 * obstacles and Stripe at length in prose — a comment saying "the desk is
 * axis-aligned" would satisfy a naive search for the same words. LINE comments
 * are stripped FIRST and the order is load-bearing: a `//` comment containing a
 * wildcard path carries the two characters that OPEN a block comment, so
 * stripping blocks first makes that line swallow everything up to the end of
 * the next JSX comment.
 */
function code(src: string): string {
  return src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const PAGE = read(join(SRC, "pages", "store-interior.tsx"));
const PAGE_CODE = code(PAGE);
const RIG_CODE = code(read(join(SRC, "components", "first-person-rig.tsx")));
const NPC_CODE = code(read(join(SRC, "components", "talkable-npc.tsx")));
const LAYOUT_CODE = code(read(join(SRC, "lib", "room-geometry.ts")));

/**
 * An element's OWN opening tag, so a rule about one of its props cannot be
 * satisfied by the same string appearing elsewhere in the file.
 *
 * `/<FirstPersonRig[\s\S]*?suspended=/` only asserts that the word appears
 * somewhere AFTER the rig's tag — which held only because each of these strings
 * happened to occur exactly once on the page. Brace depth is tracked rather
 * than scanning to the first `>`, because `onClose={() => setPanelOpen(false)}`
 * puts a `>` inside an attribute value.
 */
function openTag(src: string, element: string): string {
  const start = src.indexOf(`<${element}`);
  if (start < 0) throw new Error(`<${element}> is not rendered on this page`);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`<${element}>'s opening tag is never closed`);
}

/**
 * The body of the desk component, so a rule about it cannot be satisfied by a
 * line somewhere else in an 800-line page.
 *
 * Thrown rather than asserted, because a missing component means every test
 * below is measuring an empty string and passing — the failure has to happen at
 * collection time, loudly, rather than as a green run over nothing.
 */
const DESK_CODE = (() => {
  const start = PAGE_CODE.indexOf("function CheckoutDesk");
  const end = PAGE_CODE.indexOf("export default function StoreInterior");
  if (start < 0 || end <= start) throw new Error("CheckoutDesk is not in store-interior.tsx");
  return PAGE_CODE.slice(start, end);
})();

describe("the desk is solid, and so is everything beside it", () => {
  it("is axis-aligned — no rotation on the desk group", () => {
    // Not a preference. `FpsObstacle` is `{cx, cz, hx, hz}` with no rotation
    // term, so a rotated desk is modelled by an upright box: either loose at
    // the corners or stopping the visitor short of a desk they can see they
    // are not touching. The Joinery rotates its desk because nothing there
    // collides with anything.
    // Its OWN opening tag, and the slice is proved before it is searched: an
    // `indexOf` that returned -1 would make `slice(-1, …)` a one-character
    // string that passes every negative assertion below.
    const tag = openTag(DESK_CODE, "group");
    expect(tag.startsWith("<group"), "the desk group tag did not parse").toBe(true);
    // Both spellings. react-three-fiber's idiomatic single-axis form is
    // `rotation-y={…}`, which `\brotation=` does not match — so the most likely
    // way to rotate this desk evaded the check written to prevent it.
    expect(tag, "the desk group must carry no rotation").not.toMatch(/\brotation(-[xyz])?=/);
    // And the obstacle really is the one the issue specifies, in the units the
    // rig reads: half-extents, not a width and a depth. Read as a VALUE now
    // that the geometry is importable, rather than pattern-matched as source.
    expect(DESK_OBSTACLE).toEqual({ cx: 5.5, cz: 4.5, hx: 1.7, hz: 0.6 });
    // The box is centred on the desk it models. Two constants that drifted
    // apart would be a counter standing beside its own collision box.
    expect(DESK_OBSTACLE.cx).toBe(DESK_POSITION[0]);
    expect(DESK_OBSTACLE.cz).toBe(DESK_POSITION[2]);
  });

  it("passes obstacles to the rig at all — this page never did before", () => {
    expect(openTag(PAGE_CODE, "FirstPersonRig")).toMatch(/obstacles=\{obstacles\}/);
    expect(PAGE_CODE).toMatch(/const obstacles = useMemo\(\(\) => storeObstacles\(apps\.length\)/);
  });

  it("collides with every bench it draws", () => {
    // The rule that stops this being "solidity for the desk and nothing else",
    // which reads as a bug in the desk rather than as a decision about benches.
    // Both the drawing and the collision come off ONE array, so a bench cannot
    // be added to the room without being added to the collision pass — a
    // literal `<GalleryBench position={[...]}>` is exactly that mistake.
    // `\b[^>]*` rather than `\s+`, so a hand-placed bench that happens to carry
    // `key` first is caught too.
    expect(PAGE_CODE).not.toMatch(/<GalleryBench\b[^>]*position=\{\[/);
    expect(PAGE_CODE).toMatch(/BENCH_POSITIONS\.map\(\([^)]*\)\s*=>\s*\(?\s*<GalleryBench/);
    expect(LAYOUT_CODE).toMatch(/FIXED_OBSTACLES[\s\S]{0,300}BENCH_POSITIONS\.map\(/);
  });

  it("collides with every arcade cabinet and plant it draws, by the same one-array rule", () => {
    // The cabinets were the hole in "everything solid on this floor": a
    // 2.3m-tall machine at chest height, clickable, that the visitor walked
    // straight through — while a knee-high bench beside it stopped them. Slots
    // and obstacles come off ONE list, so a fifth cabinet cannot be drawn
    // without becoming solid.
    expect(PAGE_CODE).not.toMatch(/<ArcadeCabinet\b[^>]*position=\{\[\s*\[/);
    expect(LAYOUT_CODE).toMatch(/ARCADE_SLOT_X\.slice\(0,\s*appCount\)/);
    expect(PAGE_CODE).toMatch(/apps\.slice\(0,\s*ARCADE_SLOT_X\.length\)\.map\(/);
    expect(PAGE_CODE).toMatch(/position=\{\[ARCADE_SLOT_X\[i\]!,\s*0,\s*ARCADE_Z\]\}/);
    // The plants likewise, rather than three hand-placed literals.
    expect(PAGE_CODE).not.toMatch(/<PottedPlant\b[^>]*position=\{\[\s*-?[\d.]/);
    expect(PAGE_CODE).toMatch(/PLANT_POSITIONS\.map\(\([^)]*\)\s*=>\s*\(?\s*<PottedPlant/);
    expect(LAYOUT_CODE).toMatch(/FIXED_OBSTACLES[\s\S]{0,300}PLANT_POSITIONS\.map\(/);
  });

  it("builds a box for each cabinet a shop actually shows, and none for one it does not", () => {
    // Behavioural, over the exported rule rather than over its source: a shop
    // with no apps draws no cabinets and must not collide with four invisible
    // ones, and that is a property no string search can see.
    const none = storeObstacles(0);
    const four = storeObstacles(4);
    expect(four.length - none.length).toBe(4);
    // The row stands at z 8.1 and the floor's far edge is maxZ 8.6, which is
    // exactly how a visitor used to end up standing inside one.
    for (const box of four.slice(none.length)) {
      expect(box.cz).toBe(ARCADE_Z);
      expect(box.hx).toBeGreaterThan(0);
      expect(box.hz).toBeGreaterThan(0);
    }
    // The desk and both benches are there whatever the data says.
    expect(none.length).toBeGreaterThanOrEqual(3);
    expect(none).toContainEqual({ cx: 5.5, cz: 4.5, hx: 1.7, hz: 0.6 });
    // And a shop with more apps than slots does not grow phantom boxes.
    expect(storeObstacles(9)).toHaveLength(four.length);
  });
});

describe("the clerk is measured from where the clerk actually stands", () => {
  /**
   * The desk's clerk in WORLD coordinates.
   *
   * `CheckoutDesk` nests the NPC at local (0, −1.1) inside a group at
   * DESK_POSITION, so the person is 1.1m behind the counter. Written as the sum
   * rather than as `[5.5, 3.4]` so that moving the desk moves the expectation
   * with it.
   */
  const clerk = { x: DESK_POSITION[0], z: DESK_POSITION[2] - 1.1 };

  it("is in range from the counter, and from the post-sign-in spawn", () => {
    // The bug this file could not previously see. The old check compared the
    // world camera against the LOCAL prop, i.e. against (0, −1.1) — the middle
    // of the gallery — so standing at the counter measured ≈7.85 against a
    // range of 4.2 and no prompt ever appeared. Nothing about that is visible
    // in a screenshot or a typecheck, and no source-shape assertion can tell
    // which coordinate space a subtraction is in.
    expect(withinTalkRange({ x: DESK_POSITION[0], z: DESK_POSITION[2] + 1.2 }, clerk)).toBe(true);
    // Coming back from `/login?returnTo=…?at=desk` must land inside the range,
    // or the round trip trades the door for a spot the desk ignores.
    const spawn = { x: DESK_SPAWN.position[0], z: DESK_SPAWN.position[2] };
    expect(withinTalkRange(spawn, clerk)).toBe(true);
  });

  it("is out of range from the middle of the room", () => {
    // The other half, and the one that says the check is not simply true. The
    // centre bench at (0, −1) sits almost exactly where the broken check
    // measured from, so a regression to local coordinates makes this fail.
    expect(withinTalkRange({ x: 0, z: -1 }, clerk)).toBe(false);
    expect(withinTalkRange({ x: 0, z: 0 }, clerk)).toBe(false);
    // And the far end of the gallery, where a stray click used to open the
    // purchase panel.
    expect(withinTalkRange({ x: -8, z: -13 }, clerk)).toBe(false);
  });

  it("measures on the floor plane, at the range the city advertises", () => {
    // Eye height is 2.2m and a figure's origin is at its feet. Folding y in
    // would make everyone ~2m further away than they look and leave no usable
    // range at a counter at all.
    expect(TALK_RANGE).toBe(4.2);
    expect(withinTalkRange({ x: clerk.x, z: clerk.z + TALK_RANGE - 0.01 }, clerk)).toBe(true);
    expect(withinTalkRange({ x: clerk.x, z: clerk.z + TALK_RANGE + 0.01 }, clerk)).toBe(false);
  });

  it("reads the figure's WORLD transform rather than its position prop", () => {
    // The implementation half of the rule above. `getWorldPosition` also
    // composes any parent ROTATION, which a hand-added offset could not — the
    // Joinery's desk group is turned a quarter turn, and the residences and
    // cafe nest their NPCs the same way.
    expect(NPC_CODE).toContain("getWorldPosition");
    expect(NPC_CODE).toMatch(/withinTalkRange\(camera\.position,\s*worldPos\)/);
    // The old, wrong comparison must not come back.
    expect(NPC_CODE).not.toMatch(/camera\.position\.[xz]\s*-\s*position\[/);
  });

  it("reports the visitor out of range when it leaves the scene", () => {
    // Every caller renders its NPC conditionally — the desk only when it has
    // something to sell. Range is otherwise reported only from `useFrame`,
    // which stops on unmount, so a clerk that disappears while the visitor is
    // at the counter leaves `deskNear` latched true across the whole gallery.
    expect(NPC_CODE).toMatch(
      /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\s*if \(inRange\.current\) onRangeChangeRef\.current\(false\);\s*\},\s*\[\],?\s*\)/,
    );
  });
});

describe("the rig stops while money is moving", () => {
  it("takes a suspended prop and is given one by the desk", () => {
    expect(RIG_CODE).toMatch(/suspended\?:\s*boolean/);
    expect(openTag(PAGE_CODE, "FirstPersonRig")).toMatch(/suspended=\{paymentBusy\}/);
  });

  it("drops held keys and ends the drag on the rising edge", () => {
    // The two things `isTypingTarget()` cannot do. It stops NEW keystrokes
    // being read as movement once focus is inside Stripe's iframe, but a key
    // already held when the challenge opened stays held, and the pointer
    // listeners are bound to `window` — so a drag released over Stripe's own
    // modal still rotates the camera.
    // Sliced from its own closing line backwards, rather than matched with a
    // lazy quantifier from the first `useEffect` in the file: that would span
    // three effects and pass on a line that lived in either of the other two.
    const end = RIG_CODE.indexOf("}, [suspended]);");
    expect(end, "no effect keyed on `suspended`").toBeGreaterThan(-1);
    const effect = RIG_CODE.slice(RIG_CODE.lastIndexOf("useEffect(() => {", end), end);
    expect(effect).toContain("keys.current = {}");
    expect(effect).toContain("dragging.current = false");

    // And the rising edge is not the whole story: a key pressed DURING the
    // suspension must not be latched either. The shield over the scene is an
    // ordinary div, so one click on it moves focus to the body and
    // `isTypingTarget()` stops covering anything — after which a held W is
    // recorded and applied the instant the charge finishes, which reads as the
    // avatar bolting across the shop. Identical reasoning to the `scrollMove`
    // clear the suspended branch already carries.
    const down = RIG_CODE.slice(
      RIG_CODE.indexOf("const down = (e: KeyboardEvent)"),
      RIG_CODE.indexOf("const up = (e: KeyboardEvent)"),
    );
    expect(down, "the keydown handler did not parse").toContain("keys.current[e.code] = true");
    expect(down, "keydown latches while suspended").toContain("if (suspendedRef.current) return;");
    // `keyup` stays unconditional, or a key released during the suspension is
    // stranded as held.
    const up = RIG_CODE.slice(RIG_CODE.indexOf("const up = (e: KeyboardEvent)"));
    expect(up.slice(0, up.indexOf("\n"))).not.toContain("suspendedRef");
  });

  it("returns from the movement half BEFORE reading the keys", () => {
    // Order is the whole property. A suspension check placed after the key
    // reads would compute a movement vector and then discard it, which is
    // harmless — but one placed after the position write would not, and both
    // look like "the rig checks `suspended`" to a search.
    const frame = RIG_CODE.slice(RIG_CODE.indexOf("useFrame((_, dt)"));
    const guard = frame.indexOf("if (suspendedRef.current)");
    const movement = frame.indexOf("const k = keys.current;");
    expect(guard, "no suspension guard inside useFrame").toBeGreaterThan(-1);
    expect(movement, "the movement half is gone").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(movement);
    // And the look half survives it, because a suspended camera still has to
    // point where the player left it. Its presence is asserted BEFORE the
    // ordering comparison: `indexOf` returns -1 when the string is absent, and
    // -1 is less than every real offset — so deleting the look half entirely,
    // which is the exact failure this line is about, used to pass.
    const look = frame.indexOf("camera.rotation.set");
    expect(look, "the look half is gone").toBeGreaterThan(-1);
    expect(look).toBeLessThan(guard);
  });
});

describe("the panel is DOM, and it is the shared one", () => {
  it("mounts outside the Canvas", () => {
    // The property, stated structurally. Inside the canvas this component would
    // be a React Three Fiber child: not tabbable, not announced, and unmountable
    // on the 2D page that exists because the room is not keyboard-navigable.
    const canvasEnd = PAGE_CODE.lastIndexOf("</Canvas>");
    const mount = PAGE_CODE.indexOf("<PurchasePanel");
    expect(canvasEnd, "no Canvas").toBeGreaterThan(-1);
    expect(mount, "the panel is not mounted").toBeGreaterThan(-1);
    expect(mount, "the panel is inside the Canvas").toBeGreaterThan(canvasEnd);
  });

  it("imports the one shared component rather than growing a second flow", () => {
    expect(PAGE).toContain('import { PurchasePanel } from "@/components/purchase-panel"');
    // A second implementation of the quote / retry / poll / idempotency
    // protocol is a second chance to charge a card twice.
    expect(PAGE_CODE).not.toMatch(/\/api\/commerce\/purchase/);
    expect(PAGE_CODE).not.toMatch(/submitPurchase/);
  });

  it("never puts a card, an Elements mount or a Stripe iframe in the game view", () => {
    // `<Elements>` mounts in exactly one component in the whole application and
    // it is the settings card. The room gets `handleNextAction`, which takes a
    // client secret and no Elements instance, and it gets it through the panel.
    expect(PAGE_CODE).not.toMatch(/@stripe\//);
    expect(PAGE_CODE).not.toMatch(/<Elements[\s>]/);
    expect(PAGE_CODE).not.toMatch(/loadStripe/);
  });

  it("never spends credits on a physical good", () => {
    expect(PAGE_CODE).not.toMatch(/joinery|ledger|play_credit/i);
  });
});

describe("the player never leaves the room", () => {
  it("routes nothing from the desk", () => {
    // A route change at any point in a purchase drops the quote and the
    // idempotency reference with it, and lands the buyer back at the door.
    expect(DESK_CODE).not.toMatch(/\bnavigate\(/);
    expect(DESK_CODE).not.toMatch(/href=/);
  });

  it("sends the panel's off-page links to a new tab", () => {
    // Settings and orders are the two links a buyer follows mid-flow. In a new
    // tab the room survives, which is the only reason the panel's
    // `visibilitychange` re-check has anything to come back to.
    // On the panel's OWN tag. A lazy match from the opening tag only proves the
    // word appears somewhere later in the file, which held here purely because
    // `newTab` happens to occur once.
    expect(openTag(PAGE_CODE, "PurchasePanel")).toMatch(/\bnewTab\b/);
  });

  it("comes back to the desk after sign-in rather than to the door", () => {
    // `/s/:slug/room` is public, so most first-time buyers meet the desk signed
    // out. The round trip through `/login?returnTo=…` is the one navigation in
    // the flow, and this is what makes it cost the buyer nothing.
    expect(PAGE_CODE).toContain("signInReturnTo={`/s/${slug}/room?at=desk`}");
    expect(PAGE_CODE).toMatch(/get\("at"\)\s*!==\s*"desk"/);
    expect(openTag(PAGE_CODE, "FirstPersonRig")).toMatch(/spawn=\{spawn\}/);
    // And the arrival clears the desk's box plus the rig's own half-metre pad,
    // or the first frame would shove the visitor back out of it. Measured
    // against DESK_OBSTACLE rather than against `4.5 + 0.6` retyped as
    // literals: moving the desk used to leave the spawn inside its collision
    // box while this assertion went on passing against numbers that no longer
    // described anything in the room.
    expect(DESK_SPAWN.position[2]).toBeGreaterThan(DESK_OBSTACLE.cz + DESK_OBSTACLE.hz + 0.5);
    // Facing the counter it just put the visitor in front of, not the wall.
    expect(DESK_SPAWN.yaw).toBe(0);
  });
});

describe("E at the desk, in the city's one grammar for it", () => {
  it("copies the proximity-gated keydown idiom", () => {
    // Every venue's E handler is the same four lines, and the reason is that
    // the one that wasn't put visitors inside a shop for typing "hello".
    expect(PAGE_CODE).toContain("if (isTypingTarget()) return;");
    expect(PAGE_CODE).toMatch(/e\.code === "KeyE" && deskNear/);
    expect(PAGE_CODE).toContain("e.preventDefault();");
    expect(PAGE_CODE).toMatch(/window\.addEventListener\("keydown", onKey\)/);
  });

  it("closes the panel when the visitor walks away", () => {
    // The companion effect. Without it the panel stays pinned to the screen at
    // the far end of the gallery and reads as stuck rather than as attached to
    // a desk.
    expect(PAGE_CODE).toMatch(/if \(!deskNear\) setPanelOpen\(false\)/);
  });

  it("stands down while a charge is in flight", () => {
    // E is a toggle, and toggling the panel shut mid-purchase would unmount
    // the thing holding the idempotency reference and the poll.
    expect(PAGE_CODE).toMatch(/if \(paymentBusy \|\| playing\) return;/);
  });

  it("guards the desk's click against a look-drag", () => {
    // A drag that happens to end on the counter is not a press, and a drag
    // that opened a payment panel would be worse than one that opened a door.
    expect(DESK_CODE).toContain("if ((e.delta ?? 0) > 5) return;");
  });

  it("gates the desk's click on proximity, exactly like the key", () => {
    // An R3F raycast has no distance limit, so without this the counter is
    // clickable from the far end of the gallery — and the walk-away effect
    // cannot undo it, because that only fires when `deskNear` CHANGES and it
    // was already false. Before the coordinate fix this was the ONLY way the
    // panel opened at all, which is why it never surfaced.
    expect(DESK_CODE).toContain("if (!near) return;");
    expect(openTag(PAGE_CODE, "CheckoutDesk")).toMatch(/near=\{deskNear\}/);
  });

  it("closes a panel that is open while the visitor is not at the desk", () => {
    // `panelOpen` belongs in the dependency list as well as `deskNear`: keyed
    // on the range alone the effect never runs for a panel that opened while
    // the visitor was already far away.
    expect(PAGE_CODE).toMatch(/if \(!deskNear\) setPanelOpen\(false\);\s*\},\s*\[deskNear, panelOpen\]\)/);
  });

  it("cannot leave the rig suspended with no panel on screen", () => {
    // The soft-lock. `paymentBusy` is otherwise written only by the panel's
    // `onBusyChange`, and the panel's own `finally` is guarded by
    // `if (alive.current)` — so a panel that unmounts mid-charge strands the
    // rig `suspended` and the E handler dead (`if (paymentBusy || playing)
    // return;`) with nothing on screen to explain it, because the shield is
    // gated on the same `panelOpen` that just went false. Reloading is the one
    // thing this flow was built not to need.
    expect(PAGE_CODE).toMatch(
      /if \(!\(deskProduct && panelOpen\)\) setPaymentBusy\(false\);\s*\},\s*\[deskProduct, panelOpen\]\)/,
    );
  });

  it("does not let a background refetch yank the counter out from under a purchase", () => {
    // The app uses a bare `new QueryClient()`, so `refetchOnWindowFocus` is on
    // and `staleTime` is 0 — and returning to this tab is exactly how a 3D
    // Secure challenge and a trip to the settings tab both end. Every probe is
    // wrapped in `.catch(() => [])`, so one transient blip resolves to an empty
    // list and unmounts the panel mid-charge.
    expect(PAGE_CODE).toMatch(/refetchOnWindowFocus:\s*false/);
    expect(PAGE_CODE).toMatch(/staleTime:/);
    expect(PAGE_CODE).toMatch(/placeholderData:\s*keepPreviousData/);
  });

  it("keeps the price in the DOM prompt and out of the sprite", () => {
    // The overhead prompt is a canvas texture painted when its words change;
    // the price is a number a fresh quote can move. `promptLabel` carries the
    // verb and `formatMoney` runs in the DOM half of the page, after the
    // `</Canvas>`.
    expect(PAGE_CODE).toMatch(/promptLabel = buyable \? "\[ E \] BUY" : "\[ E \] CHECKOUT"/);
    const canvasEnd = PAGE_CODE.lastIndexOf("</Canvas>");
    const priced = PAGE_CODE.indexOf("formatMoney(deskProduct");
    expect(priced, "the desk prompt shows no price").toBeGreaterThan(-1);
    expect(priced, "the price is being drawn into the scene").toBeGreaterThan(canvasEnd);
  });
});

describe("every drei Text carries its own Suspense boundary", () => {
  it("is inside one, everywhere on this page", () => {
    // A missing boundary does not throw and does not warn — it blanks the whole
    // scene on a cold font fetch, and only on a cold one, which is why this has
    // been shipped more than once here. Counted as a depth rather than searched
    // for as a nearby string, so a `<Text>` added after a `</Suspense>` fails.
    const tokens = [...PAGE_CODE.matchAll(/<Suspense\b|<\/Suspense>|<Text\b/g)];
    let depth = 0;
    let seen = 0;
    for (const token of tokens) {
      if (token[0] === "<Suspense") depth += 1;
      else if (token[0] === "</Suspense>") depth -= 1;
      else {
        seen += 1;
        expect(depth, `a <Text> at offset ${token.index} has no Suspense boundary`).toBeGreaterThan(0);
      }
    }
    // The loop must have had something to walk over. Every one of these is a
    // sign in the room, and the desk added one more.
    expect(seen, "no drei <Text> on the page at all").toBeGreaterThan(5);
    expect(depth, "unbalanced Suspense tags").toBe(0);
    expect(DESK_CODE).toMatch(/<Suspense fallback=\{null\}>[\s\S]*?<Text/);
  });
});
