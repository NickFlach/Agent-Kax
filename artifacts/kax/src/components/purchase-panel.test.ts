/**
 * purchase-panel.test.ts — one purchase flow, two doors, and a door that works
 * without a mouse.
 *
 * The panel is mounted from the 2D artifact page and — with #288 — from the
 * in-city checkout desk. That has to be ONE component, and the reason is not
 * tidiness: the quote / retry / poll / idempotency protocol it implements is
 * the only thing standing between a lost response and a card charged twice, and
 * a second implementation is a second chance to get that wrong somewhere nobody
 * is looking. A copy would typecheck, build, and work in the happy path.
 *
 * The accessibility rule is structural for the same reason. The 3D room is not
 * keyboard-navigable — `pages/marketplace-3d.tsx` carries an sr-only skip link
 * and a whole storefront `<nav>` precisely because of that — so the 2D page is
 * how a keyboard or screen-reader user buys anything at all. A control built
 * out of a `<div onClick>` is invisible to both, and it looks identical on
 * screen.
 *
 * Read as source rather than rendered, in the idiom of `App.routes.test.ts` and
 * `physical-purchasing-card.test.ts`, and for the same reason those are: there
 * is no DOM here, and a property that has to hold for every file including the
 * one added next month cannot be established by mounting the two that exist
 * today.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** Every TypeScript source file under `src`, tests excluded. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function rel(path: string): string {
  return relative(SRC, path).replace(/\\/g, "/");
}

/**
 * The file with its comments removed.
 *
 * Every rule below is about what the code DOES, and these files discuss Stripe,
 * ledgers and purchase endpoints at length in prose. LINE comments are stripped
 * FIRST and the order is load-bearing: a `//` comment mentioning a wildcard
 * path carries the two characters that OPEN a block comment, so stripping
 * blocks first makes that line swallow everything up to the next block
 * terminator — which in a TSX file is the end of the next JSX comment. That
 * silently emptied half of a sibling test's view of its component on the first
 * run, and its negative assertions passed against nothing at all.
 */
function code(src: string): string {
  return src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const PANEL_PATH = join(SRC, "components", "purchase-panel.tsx");
const PANEL_CODE = code(read(PANEL_PATH));
const ARTIFACT_PAGE_PATH = join(SRC, "pages", "agent-storefront-artifact.tsx");
const ARTIFACT_PAGE = read(ARTIFACT_PAGE_PATH);
const APP = read(join(SRC, "App.tsx"));
const ORDERS_PAGE = read(join(SRC, "pages", "orders.tsx"));

const ALL = sourceFiles().map((path) => ({ path, text: read(path) }));

describe("one component, one code path", () => {
  it("is defined in exactly one file", () => {
    // A second definition would satisfy every "does it import PurchasePanel"
    // check below while being an entirely separate flow.
    const definers = ALL.filter((f) => /export function PurchasePanel\b/.test(code(f.text))).map(
      (f) => rel(f.path),
    );
    expect(definers).toEqual(["components/purchase-panel.tsx"]);
  });

  it("is the only thing in the app that posts a physical purchase", () => {
    // The property that matters. `POST /commerce/purchase` is where a card is
    // charged, and every caller of it has to go through the reference-reuse
    // rules in `lib/commerce.ts` — a second `fetch` of that path anywhere is a
    // second idempotency implementation.
    const callers = ALL.filter((f) => /\/api\/commerce\/purchase/.test(code(f.text))).map((f) =>
      rel(f.path),
    );
    expect(callers).toEqual(["lib/commerce.ts"]);

    const submitters = ALL.filter((f) => /\bsubmitPurchase\s*\(/.test(code(f.text)))
      .map((f) => rel(f.path))
      .sort();
    expect(submitters).toEqual(["components/purchase-panel.tsx", "lib/commerce.ts"]);
  });

  it("is mounted by the 2D artifact page", () => {
    // The accessible door. #289's whole premise is that the in-city desk cannot
    // be the only way to buy a physical thing.
    expect(ARTIFACT_PAGE).toContain('import { PurchasePanel } from "@/components/purchase-panel"');
    expect(code(ARTIFACT_PAGE)).toMatch(/<PurchasePanel[\s>]/);
  });

  it("is mounted only by pages, and every mount imports the shared module", () => {
    // Written as a property rather than as a fixed list of two files, so that
    // the in-city desk (#288) mounting the same component makes this pass
    // rather than fail — while a page that grew its own copy still fails. Every
    // file that renders the panel must both mount it and import it from the one
    // module that defines it.
    const mounts = ALL.filter((f) => /<PurchasePanel[\s>]/.test(code(f.text)));
    expect(mounts.length, "nothing mounts the panel at all").toBeGreaterThan(0);
    for (const file of mounts) {
      expect(rel(file.path), "the panel belongs on a page").toMatch(/^pages\//);
      expect(code(file.text), rel(file.path)).toContain('from "@/components/purchase-panel"');
    }
    expect(mounts.map((f) => rel(f.path))).toContain("pages/agent-storefront-artifact.tsx");
  });

  it("is the component the in-city desk mounts too", () => {
    // #288's whole premise, stated from the desk's side. The 3D room is the
    // scenic door and the 2D page is the accessible one, and they have to be
    // the same door: a desk with its own purchase code would be a second
    // implementation of the idempotency protocol in the file least likely to
    // be read.
    expect(mountsOfThePanel()).toContain("pages/store-interior.tsx");
  });
});

/** Every page that renders `<PurchasePanel>`, by path. */
function mountsOfThePanel(): string[] {
  return ALL.filter((f) => /<PurchasePanel[\s>]/.test(code(f.text))).map((f) => rel(f.path));
}

describe("the panel can be mounted anywhere, including outside a Canvas", () => {
  it("imports nothing from the 3D stack", () => {
    // The desk renders this OUTSIDE its `<Canvas>` as a sibling to the play
    // overlay. A drei or fiber import here would make it a scene object: not
    // tabbable, not readable by a screen reader, and unmountable on a 2D page.
    expect(PANEL_CODE).not.toMatch(/from\s+"three"/);
    expect(PANEL_CODE).not.toMatch(/from\s+"@react-three\//);
  });

  it("mounts no Stripe Elements and imports no card-entry package", () => {
    // `<Elements>` mounts in exactly one component in the whole application —
    // the settings card — and `physical-purchasing-card.test.ts` asserts that
    // list is exactly one entry long. This is the same rule stated from the
    // other side, so that a card field added here fails twice.
    expect(PANEL_CODE).not.toMatch(/from\s+"@stripe\/react-stripe-js"/);
    expect(PANEL_CODE).not.toMatch(/<Elements[\s>]/);
    expect(PANEL_CODE).not.toMatch(/<PaymentElement[\s>]/);
    expect(PANEL_CODE).not.toMatch(/<AddressElement[\s>]/);
  });

  it("loads Stripe.js lazily, through the /pure entry", () => {
    // The bare `@stripe/stripe-js` entry starts fetching Stripe.js at MODULE
    // evaluation time — Stripe ships `/pure` precisely to defer that to the
    // first `loadStripe()` call. `store-interior.tsx` statically imports this
    // panel, which statically imports the loader, so the bare entry put a
    // js.stripe.com fetch and Stripe's hidden fraud-detection iframe into the
    // game view on arrival. `getStripe()` being lazy does not help: the side
    // effect is at import time, not at call time.
    const LOADER = code(read(join(SRC, "lib", "stripe.ts")));
    expect(LOADER).toMatch(/import\s*\{[^}]*loadStripe[^}]*\}\s*from\s*"@stripe\/stripe-js\/pure"/);
    // And the eager entry is not imported for a VALUE anywhere in it. A
    // `import type` from the bare entry is fine — types are erased and carry no
    // module evaluation — so the rule is stated against non-type imports only.
    expect(LOADER).not.toMatch(/import\s+(?!type\b)[^;]*from\s*"@stripe\/stripe-js"/);
  });

  it("reaches Stripe only for a bank challenge, through the shared loader", () => {
    // `handleNextAction` takes a client secret and no Elements instance, which
    // is why a purchase can happen in the game view with no Stripe iframe in
    // it under normal conditions. `loadStripe` itself is called in exactly one
    // place — two calls are two Stripe objects — and that place is `lib/stripe.ts`.
    expect(PANEL_CODE).toContain("handleNextAction({ clientSecret");
    expect(PANEL_CODE).toContain('from "@/lib/stripe"');
    expect(PANEL_CODE).not.toMatch(/\bloadStripe\s*\(/);
    expect(PANEL_CODE).not.toMatch(/confirmSetup\s*\(/);
  });

  it("has no field a card number, CVC or expiry could be typed into", () => {
    // There is no moment in which this component holds a card. The names below
    // are the ones a well-meaning refactor introduces.
    for (const pattern of [/card_?number/i, /\bcvc\b/i, /\bcvv\b/i, /security_?code/i]) {
      expect(PANEL_CODE, String(pattern)).not.toMatch(pattern);
    }
  });

  it("never spends credits on a physical good", () => {
    // play_credit must not be able to buy a parcel. The server guarantees it
    // structurally; this is the client half.
    expect(PANEL_CODE).not.toMatch(/joinery|ledger|play_credit/i);
  });
});

describe("one press of Buy is one charge", () => {
  it("mints the reference once and reuses it across retries", () => {
    // `??=` is the whole rule, in one operator. A plain assignment here mints a
    // fresh key on every press, so a buyer pressing Buy again after a lost
    // response buys the thing twice — and nothing else in the suite would
    // notice, because `shouldReuseReference` is tested against hand-built
    // errors that never travel through this line.
    expect(PANEL_CODE).toContain("reference.current ??= newClientReference()");
    expect(PANEL_CODE).not.toMatch(/reference\.current\s*=\s*newClientReference\(\)/);
  });

  it("clears the reference only when the server gave a verdict", () => {
    // The other half. An answered refusal is a decision about THIS reference
    // and every retry under it gets the same answer, so the key is spent; an
    // unanswered send is the opposite and the key survives. The decision is
    // delegated to `shouldReuseReference` rather than re-derived from the shape
    // of the catch block.
    expect(PANEL_CODE).toContain("if (!shouldReuseReference(err)) reference.current = null;");
  });

  it("releases the rig's suspension when it unmounts mid-charge", () => {
    // `buy()`'s `finally` is guarded by `if (alive.current)`, so a panel that
    // disappears while busy never reports `busy = false` — and the desk drives
    // its first-person rig's `suspended` prop off that callback. The player is
    // then unable to walk, look or reopen the panel until they reload, with
    // nothing on screen saying why. It must be its OWN mount-scoped effect: a
    // cleanup on the `[busy]` effect would emit false before every true and
    // unsuspend the rig mid-charge.
    expect(PANEL_CODE).toMatch(
      /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\s*onBusyChangeRef\.current\?\.\(false\);\s*\},\s*\[\],?\s*\)/,
    );
  });

  it("does not report an abandoned bank challenge as an order placed", () => {
    // A buyer who closes the 3DS modal produces an error from
    // `handleNextAction`. The order stays at `authenticating`, no webhook will
    // ever settle it, so the poll runs its full minute and returns null — which
    // used to land in exactly the same branch as a genuinely slow charge and
    // told somebody who cancelled their own payment that an order was placed.
    // The two timeout paths must stay distinguishable.
    const start = PANEL_CODE.indexOf("if (challengeErrored && polledOut)");
    expect(start, "the abandoned-challenge case is not distinguished at all").toBeGreaterThan(-1);
    // Bounded at its own `return;` so every assertion below is about THIS
    // branch rather than about the rest of `buy()`.
    const branch = PANEL_CODE.slice(start, PANEL_CODE.indexOf("return;", start));
    expect(branch, "the branch is empty — the slice has drifted").toContain("setFailure(");
    // It is a refusal offering the purchase again, not a receipt: `setSettled`
    // is what renders "Order placed" and a link to /orders.
    expect(branch).toContain('recourse: "retry"');
    expect(branch).not.toContain("setSettled(");
    expect(branch).toMatch(/nothing was charged/);
  });
});

describe("the panel works without a mouse", () => {
  it("puts every action on a button or a link", () => {
    // The rule that makes this the accessible path. A `<div onClick>` is not
    // focusable, is not announced, and cannot be activated with Enter — and it
    // renders identically. Each `onClick` is traced back to the tag it sits on.
    const offenders: string[] = [];
    for (const match of PANEL_CODE.matchAll(/onClick=/g)) {
      const open = PANEL_CODE.lastIndexOf("<", match.index!);
      const tag = /^<\s*([A-Za-z][\w.]*)/.exec(PANEL_CODE.slice(open, match.index!))?.[1] ?? "?";
      if (tag !== "Button" && tag !== "button") offenders.push(tag);
    }
    expect(offenders, "click handlers on things a keyboard cannot reach").toEqual([]);
    // And there is at least one, so the loop above is not passing over nothing.
    expect(PANEL_CODE).toContain("onClick={buy}");
  });

  it("announces what is happening through a live region", () => {
    // A charge takes seconds and passes through several states. A sighted buyer
    // reads the button label; everyone else needs the change announced.
    expect(PANEL_CODE).toContain('role="status"');
    expect(PANEL_CODE).toContain('aria-live="polite"');
    // And a refusal is assertive enough to interrupt, because it is the thing
    // that stops the purchase.
    expect(PANEL_CODE).toContain('role="alert"');
  });

  it("labels itself and offers sign-in as a real link", () => {
    // `/s/:slug` and `/s/:slug/room` are both public, so most first-time buyers
    // meet this panel signed out. A button that calls `login()` would not be
    // openable in a new tab and would not survive JavaScript failing.
    expect(PANEL_CODE).toContain("aria-labelledby={headingId}");
    expect(PANEL_CODE).toContain("/login?returnTo=");
  });
});

describe("the digital path is untouched", () => {
  it("still redirects a listing to hosted Checkout", () => {
    // `routes/store-checkout.ts` is a working digital path with its own table,
    // its own Stripe object and its own webhook branch. #289 replaces it for
    // PHYSICAL products only, and deleting this call would silently make every
    // digital listing unbuyable.
    expect(ARTIFACT_PAGE).toContain("/api/store/listings/${listing.id}/checkout");
    expect(ARTIFACT_PAGE).toContain('data-testid="button-buy"');
  });

  it("keeps the two flows on separate endpoints", () => {
    // The physical panel must never reach the digital checkout, and the digital
    // button must never reach the commerce purchase.
    expect(PANEL_CODE).not.toMatch(/store\/listings/);
    expect(PANEL_CODE).not.toMatch(/store-checkout/);
  });
});

describe("the orders page", () => {
  it("is routed, behind auth, and code-split", () => {
    expect(APP).toContain('const Orders = lazy(() => import("@/pages/orders"))');
    expect(APP).toMatch(/<Route path="\/orders">\s*<RequireAuth><Orders \/><\/RequireAuth>/);
    // Without the ADMIN_PATHS entry the route matches nothing: `Router()` sends
    // anything outside that list to the public switch, which has no /orders and
    // falls through to NotFound.
    //
    // Sliced out of the array itself rather than searched for across the file.
    // `App.tsx` also lists `{ href: "/orders", label: "Orders" }` in the mobile
    // nav, which contains the substring `"/orders",` — so a whole-file
    // `toContain` stayed green with the ADMIN_PATHS entry deleted, i.e. against
    // the exact regression it was written to catch.
    const start = APP.indexOf("const ADMIN_PATHS = [");
    expect(start, "ADMIN_PATHS is not declared the way this test reads it").toBeGreaterThan(-1);
    const end = APP.indexOf("];", start);
    expect(end, "ADMIN_PATHS is not terminated the way this test reads it").toBeGreaterThan(start);
    const adminPaths = APP.slice(start, end);
    // Anti-vacuity: a parser that stopped matching would hand the assertion
    // below an empty string, and an empty string contains nothing — so prove
    // the slice is the real list first.
    expect(adminPaths).toContain('"/admin"');
    expect(adminPaths).toContain('"/dashboard"');
    expect(adminPaths).toContain('"/orders"');
  });

  it("finally consumes the shipped-but-unused digital order list", () => {
    // `GET /store/my-orders` has been on the server since the hosted-Checkout
    // path shipped, with nothing in the application reading it.
    expect(code(ORDERS_PAGE)).toContain("fetchDigitalOrders");
    expect(code(ORDERS_PAGE)).toContain("fetchPhysicalOrders");
    const consumers = ALL.filter((f) => /\/api\/store\/my-orders/.test(code(f.text))).map((f) =>
      rel(f.path),
    );
    expect(consumers).toEqual(["lib/commerce.ts"]);
  });

  it("shows fulfilment beside payment rather than instead of it", () => {
    // Two states on two clocks: a paid order is unfulfilled until somebody
    // submits it, and a shipped order can still go to chargeback. Rendering one
    // in place of the other loses whichever the buyer needed.
    expect(code(ORDERS_PAGE)).toContain("ORDER_STATUS_LABEL");
    expect(code(ORDERS_PAGE)).toContain("FULFILLMENT_LABEL");
    expect(code(ORDERS_PAGE)).toContain("showsFulfillment(order)");
  });

  it("never renders a shipping address", () => {
    // No endpoint on either path returns one, and this is the page that would
    // be the obvious place to add it. The `ship_to_*` snapshot stays on the row.
    expect(code(ORDERS_PAGE)).not.toMatch(/shipTo|line1|postalCode/);
  });
});
