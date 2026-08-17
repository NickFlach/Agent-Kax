/**
 * physical-purchasing-card.test.ts — the properties that keep card data out of
 * this application, checked as source.
 *
 * These are not style rules. "Card data never reaches our server" is a claim
 * this repo makes to a payment processor, and it holds only while three
 * structural facts hold: Stripe.js is fetched from Stripe rather than bundled,
 * the card fields exist in exactly one component so there is one place to audit,
 * and the only card-shaped identifier that crosses our wire is a SetupIntent id
 * the server independently verifies the ownership of. Each of those is one
 * import away from being false, and none of them fails a typecheck, a build, or
 * a rendered page — a second `<Elements>` in the 3D route would work perfectly
 * and quietly double the surface under PCI scope.
 *
 * Read as source rather than rendered, in the idiom of `App.routes.test.ts` and
 * `unit-interior.test.ts`, and for the same reason those are: there is no DOM
 * here, and a property that has to hold for every file including the one added
 * next month cannot be established by mounting the two that exist today.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const KAX = join(SRC, "..");
const API_SERVER = join(KAX, "..", "api-server", "src");

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

/** A source file's path as written in this test's expectations. */
function rel(path: string): string {
  return relative(SRC, path).replace(/\\/g, "/");
}

/**
 * The file with its comments removed.
 *
 * Every rule below is about what the code DOES, and these files talk about
 * payment methods and Stripe packages at length in prose. Scanning the raw text
 * for `pm_` would fail on a comment explaining why `pm_` is never sent, which is
 * a guard that punishes the documentation it depends on.
 *
 * LINE comments go first, and the order is load-bearing. A `//` comment that
 * mentions a wildcard path — a slash followed by an asterisk — carries the two
 * characters that OPEN a block comment, so stripping blocks first makes that
 * line swallow everything up to the next block-comment terminator, which in a
 * TSX file is the end of the next JSX comment. That is not hypothetical: it
 * silently emptied half of this file's view of the component on the first run,
 * and the positive assertions below failed while the negative ones passed
 * against nothing at all.
 */
function code(src: string): string {
  return src.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const CARD_PATH = join(SRC, "components", "physical-purchasing-card.tsx");
const CARD = read(CARD_PATH);
const CARD_CODE = code(CARD);
const LIB_PATH = join(SRC, "lib", "purchasing.ts");
const LIB_CODE = code(read(LIB_PATH));
const LOADER_PATH = join(SRC, "lib", "stripe.ts");
const LOADER_CODE = code(read(LOADER_PATH));
const DASHBOARD = read(join(SRC, "pages", "dashboard.tsx"));
const SERVER_ROUTE = read(join(API_SERVER, "routes", "purchasing.ts"));
const SERVER_STATE = read(join(API_SERVER, "lib", "purchasingState.ts"));

const ALL = sourceFiles().map((path) => ({ path, text: read(path) }));

describe("Stripe Elements mounts in exactly one place", () => {
  it("is imported by one component and no other", () => {
    // The rule the whole PCI position rests on. A second component importing
    // this package is a second set of card fields, in a second bundle, under a
    // second set of eyes — and it would work, which is why nothing else would
    // report it.
    const importers = ALL.filter((f) => /from\s+"@stripe\/react-stripe-js"/.test(code(f.text))).map(
      (f) => rel(f.path),
    );
    expect(importers).toEqual(["components/physical-purchasing-card.tsx"]);
  });

  it("actually mounts the provider there", () => {
    // Without this the test above would pass against a card that had been
    // gutted, and "exactly one mount" would be satisfied by zero.
    const mounts = ALL.filter((f) => /<Elements[\s>]/.test(code(f.text))).map((f) => rel(f.path));
    expect(mounts).toEqual(["components/physical-purchasing-card.tsx"]);
    expect(CARD_CODE).toContain("<Elements");
  });

  it("keeps the Elements package out of the shared loader", () => {
    // The 3D checkout desk needs `handleNextAction`, which takes a client
    // secret and no Elements instance. It imports the loader; if the loader
    // imported the Elements package, the game route would pull the card-entry
    // components in with it and the "no Stripe iframe in the game view"
    // property would be a matter of luck.
    expect(LOADER_CODE).not.toMatch(/from\s+"@stripe\/react-stripe-js"/);
    expect(LOADER_CODE).toMatch(/from\s+"@stripe\/stripe-js"/);
  });
});

describe("Stripe.js comes from Stripe", () => {
  it("is loaded exactly once, by the shared loader", () => {
    // Two `loadStripe` calls are two Stripe objects, and an Elements instance
    // built on one cannot confirm an intent through the other. The failure is a
    // confirmation that silently does nothing.
    const callers = ALL.filter((f) => /\bloadStripe\s*\(/.test(code(f.text))).map((f) =>
      rel(f.path),
    );
    expect(callers).toEqual(["lib/stripe.ts"]);
    const calls = [...LOADER_CODE.matchAll(/\bloadStripe\s*\(/g)];
    expect(calls).toHaveLength(1);
  });

  it("is never vendored, bundled, or self-hosted", () => {
    // A local copy of Stripe.js puts our build between the buyer's keystrokes
    // and the processor, which is the thing SAQ A says we do not do. Both
    // halves of how that would happen are checked: an asset shipped in
    // `public/`, and a hand-injected script tag.
    const assets = readdirSync(join(KAX, "public"));
    expect(assets.filter((a) => /stripe/i.test(a))).toEqual([]);
    for (const file of ALL) {
      expect(code(file.text), rel(file.path)).not.toMatch(/<script[^>]*stripe/i);
    }
    expect(read(join(KAX, "index.html"))).not.toMatch(/stripe/i);
  });

  it("declares both Stripe packages as dependencies", () => {
    // Neither was present before this card existed. A missing entry builds
    // locally off a hoisted node_modules and fails only in CI, or worse,
    // resolves to a transitive copy nobody chose.
    const pkg = JSON.parse(read(join(KAX, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.devDependencies, ...pkg.dependencies };
    expect(Object.keys(declared)).toContain("@stripe/stripe-js");
    expect(Object.keys(declared)).toContain("@stripe/react-stripe-js");
  });
});

describe("no card data ever reaches a KAX endpoint", () => {
  it("has no field a card number, CVC or expiry could be typed into", () => {
    // Every one of these names is something a well-meaning refactor adds while
    // "just handling the card on our side for a moment". There is no moment:
    // the fields live in Stripe's iframe and this component has no state for
    // them.
    const forbidden = [/card_?number/i, /\bcvc\b/i, /\bcvv\b/i, /security_?code/i];
    for (const pattern of forbidden) {
      expect(CARD_CODE, String(pattern)).not.toMatch(pattern);
      expect(LIB_CODE, String(pattern)).not.toMatch(pattern);
    }
  });

  it("sends a SetupIntent id and never a payment method id", () => {
    // The server's single security hinge: it derives the payment method from a
    // SetupIntent whose Customer it has checked against this account. A client
    // that posted a `pm_...` would be refused there — but the reason it is
    // never sent is that there is no code here that could construct one.
    // `pm_detached` is one of the server's twelve state codes and is excluded
    // by name; every other `pm_` is a Stripe payment-method id.
    const stripePaymentMethodId = /\bpm_(?!detached\b)/;
    expect(LIB_CODE).toContain("setupIntentId");
    expect(LIB_CODE).not.toMatch(stripePaymentMethodId);
    expect(LIB_CODE).not.toMatch(/paymentMethodId/);
    expect(CARD_CODE).not.toMatch(stripePaymentMethodId);
    expect(CARD_CODE).not.toMatch(/paymentMethodId/);
    // And what IS sent is the id off the confirmed intent.
    expect(CARD_CODE).toContain("savePaymentMethod(setupIntent.id)");
  });

  it("keeps the buyer on the dashboard through confirmation", () => {
    // Without `redirect: "if_required"` Stripe navigates away for every card,
    // and the buyer comes back to a dashboard that has forgotten which panel
    // they were in.
    const confirms = ALL.filter((f) => /confirmSetup\s*\(/.test(code(f.text))).map((f) =>
      rel(f.path),
    );
    expect(confirms).toEqual(["components/physical-purchasing-card.tsx"]);

    const start = CARD_CODE.indexOf("confirmSetup({");
    expect(start, "confirmSetup is no longer called the way this test reads it").toBeGreaterThan(-1);
    const call = CARD_CODE.slice(start, CARD_CODE.indexOf("});", start));
    expect(call).toContain('redirect: "if_required"');
  });
});

describe("the desk speaks the server's language", () => {
  it("restricts the address element to the countries the server accepts", () => {
    // Hard-coding `["US"]` here would either offer a country the PUT then
    // refuses, or keep offering only the US for as long as it took somebody to
    // notice the server's list had grown.
    expect(CARD_CODE).toContain("allowedCountries: supportedCountries");
    expect(CARD_CODE, "a literal country list is the thing this forbids").not.toMatch(
      /allowedCountries\s*[:=]\s*[[{"']/,
    );
    // And the value it reads is the server's own constant, served with the
    // terms rather than duplicated.
    expect(SERVER_ROUTE).toContain("supportedCountries: SUPPORTED_SHIP_TO_COUNTRIES");
    expect(SERVER_STATE).toMatch(/export const SUPPORTED_SHIP_TO_COUNTRIES/);
  });

  it("renders the terms the server serves, not a copy", () => {
    // `user_purchasing_consents.terms_sha256` is the digest of the document the
    // server holds. Showing anything else makes the hash a record of words
    // nobody read.
    expect(CARD_CODE).toContain("terms.markdown");
    expect(LIB_CODE).toContain('"/terms"');
  });

  it("never computes a purchasing state of its own", () => {
    // The client's state is a hint; the server recomputes and refuses. A
    // snapshot assembled here would be a permission nothing granted — and the
    // header would go green on an account the purchase endpoint is about to
    // turn away.
    expect(CARD_CODE, "no snapshot is constructed in the client").not.toMatch(/\bstate:\s*["'`]/);
    expect(CARD_CODE).not.toMatch(/\breasons:\s*\[/);
    // The badge is rendered from the snapshot `/me` reported.
    expect(CARD_CODE).toContain("purchasingCopy(purchasing.state)");
    // And both editors hand up a snapshot that came straight off a response.
    expect([...CARD_CODE.matchAll(/onSaved\(await save/g)]).toHaveLength(2);
  });

  it("never routes a physical purchase through the credit ledger", () => {
    // play_credit must not be able to buy a parcel. The server guarantees that
    // structurally — nothing on the physical path imports the ledger — and the
    // client half of the same rule is that this panel touches neither the
    // Joinery nor a credit balance.
    expect(CARD_CODE).not.toMatch(/joinery|ledger|play_credit|credits/i);
    expect(LIB_CODE).not.toMatch(/joinery|ledger|play_credit|credits/i);
  });
});

describe("the dashboard slot", () => {
  it("mounts the card in the settings grid", () => {
    expect(DASHBOARD).toContain(
      'import { PhysicalPurchasingCard } from "@/components/physical-purchasing-card"',
    );
    expect(DASHBOARD).toContain("<PhysicalPurchasingCard />");
  });

  it("carries the anchor the in-city desk deep-links to", () => {
    // `/dashboard#physical-purchasing` is a URL the 3D checkout desk hands a
    // buyer who has to go and set something up. An anchor that quietly changed
    // name would send them to the top of the page with no idea why.
    expect(CARD_CODE).toContain('id="physical-purchasing"');
    expect(CARD_CODE).toContain("/dashboard#physical-purchasing");
  });
});
