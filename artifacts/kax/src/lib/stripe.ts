/**
 * The one Stripe.js instance this app ever has.
 *
 * Stripe.js is fetched from `js.stripe.com` by `loadStripe` and is never
 * bundled, vendored, or copied into `public/`. That is a PCI condition rather
 * than a performance preference: the card fields live in an iframe served by
 * Stripe from Stripe's own origin, and a self-hosted copy of the library would
 * put our build between the buyer's keystrokes and the processor — which is
 * precisely the thing SAQ A exists to say we do not do. There is no version to
 * pin here and no local asset to check for, because there is no local asset.
 *
 * The promise is memoised at module scope. `loadStripe` injects a script tag
 * and Stripe's own documentation is explicit that it must not be called on
 * every render; two calls also mean two Stripe objects, and an Elements
 * instance created against one of them cannot confirm an intent through the
 * other.
 *
 * This module deliberately imports nothing from `@stripe/react-stripe-js`.
 * `<Elements>` mounts in exactly one component in the whole application —
 * `components/physical-purchasing-card.tsx` — and the 3D checkout desk needs a
 * Stripe object for `handleNextAction({ clientSecret })` and nothing else. If
 * the loader lived beside the Elements provider, importing it from the game
 * route would drag the card-entry components into the 3D bundle and put a
 * Stripe iframe in a view that must never have one.
 */

/**
 * The `/pure` entry, and that import path is load-bearing.
 *
 * The bare `@stripe/stripe-js` entry begins fetching Stripe.js as soon as the
 * MODULE is evaluated — Stripe ships `/pure` precisely to defer that until
 * `loadStripe()` is actually called. `getStripe()` being lazy does not help,
 * because the side effect is at import time, not at call time.
 *
 * `pages/store-interior.tsx` statically imports `PurchasePanel`, which
 * statically imports this module, so with the eager entry merely walking into
 * `/s/:slug/room` fetched js.stripe.com and let Stripe inject its hidden
 * fraud-detection iframe into the game view — breaking the rule that there is
 * no Stripe iframe in the room under normal conditions, and contradicting this
 * file's own promise. The settings card still gets Stripe.js the moment it
 * mounts, because that is when it calls `getStripe()`.
 *
 * The type comes from the bare entry: `import type` is erased at compile time
 * and carries no module evaluation with it.
 */
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";

/**
 * The publishable key, from the build environment.
 *
 * Publishable keys are public by design — they identify the account and can do
 * nothing but create client-side tokens — so shipping one in the bundle is
 * correct rather than merely tolerable. It is read through `import.meta.env`
 * because Vite inlines `VITE_`-prefixed values at build time; a deployment that
 * turns `KAX_COMMERCE_ENABLED` on without also setting this gets a card that
 * says so (see `getStripe` returning null) instead of a blank panel or a
 * loader called with no key at all, which throws on the dashboard.
 */
export const STRIPE_PUBLISHABLE_KEY: string =
  (import.meta.env["VITE_STRIPE_PUBLISHABLE_KEY"] as string | undefined) ?? "";

let cached: Promise<Stripe | null> | null = null;

/**
 * The shared Stripe object, or null when no publishable key was configured.
 *
 * Null rather than a rejected promise: "commerce is on but this build has no
 * publishable key" is a deployment state, not an exception, and the caller's
 * job is to render a sentence about it — not to catch something.
 */
export function getStripe(): Promise<Stripe | null> | null {
  if (!STRIPE_PUBLISHABLE_KEY) return null;
  cached ??= loadStripe(STRIPE_PUBLISHABLE_KEY);
  return cached;
}
