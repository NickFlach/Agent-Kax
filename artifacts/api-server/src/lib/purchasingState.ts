/**
 * Whether an account may buy a physical thing, derived from what is on file
 * plus the clock.
 *
 * Nothing here is stored. A `purchasing_enabled` boolean would be wrong the
 * instant a card passed its expiry month, and it would stay wrong until
 * something remembered to go and rewrite it — which is to say it would be
 * wrong for as long as it took someone to notice a failed charge. The rows in
 * `user_shipping_addresses`, `user_payment_methods` and
 * `user_purchasing_consents` are facts; this is the conclusion drawn from them,
 * and it is drawn again on every read.
 *
 * The module is deliberately pure: no database, no environment, no `Date.now()`
 * — `now` is an argument. That is what lets the expiry boundary be tested at
 * the exact instant it moves rather than approximately, and it is why this file
 * imports nothing from `@workspace/db` (importing it opens a connection pool,
 * and a unit test of arithmetic should not need Postgres).
 *
 * The vocabulary is shared on purpose. The checkout desk renders one of these
 * states, `GET /me` reports one of them, and the purchase endpoint will refuse
 * with one of them — the client's copy is advisory and the server recomputes,
 * but both sides say the same words about the same account.
 */

/**
 * Every conclusion this module can reach, in the order that decides which one
 * becomes the headline `state` when several are true at once.
 *
 * The order is the argument. `not_configured` outranks `consent_stale` because
 * an account with nothing on file should be told to set purchasing up, not
 * asked to re-accept terms for a card it does not have; `unsupported_destination`
 * outranks the missing halves because adding a card does not make a parcel
 * reach a country we cannot send it to. `card_expiring` is last because it is
 * the only one that does not block a purchase.
 */
export const PURCHASING_STATES = [
  /** The commerce surface is not switched on in this environment at all. */
  "disabled",
  /** No session. The desk offers sign-in rather than a reason. */
  "anonymous",
  /** Nothing on file: no address and no card, not even a removed one. */
  "not_configured",
  /** An address we cannot ship to. Not fixable from settings, so say so. */
  "unsupported_destination",
  /** A card, but nowhere to send the parcel. */
  "needs_address",
  /** An address, but nothing to charge. */
  "needs_payment_method",
  /** There WAS a card and it is gone — removed here or in Stripe's dashboard. */
  "pm_detached",
  /** The card on file is past the last day of its printed expiry month. */
  "card_expired",
  /** The stored-card terms have moved on since this account accepted them. */
  "consent_stale",
  /** Already at the 24-hour purchase limit. */
  "cap_reached",
  /** Buyable, but the card will stop working soon. Advisory only. */
  "card_expiring",
  /** Everything green. */
  "ready",
] as const;

export type PurchasingState = (typeof PURCHASING_STATES)[number];

/**
 * The one reason that does not stop a purchase. Kept as a set rather than an
 * `=== "card_expiring"` so that adding a second advisory reason is a one-line
 * change instead of a hunt for every comparison.
 */
const ADVISORY_REASONS: ReadonlySet<PurchasingState> = new Set<PurchasingState>(["card_expiring"]);

/** Destinations v0.1 will send a parcel to. */
export const SUPPORTED_SHIP_TO_COUNTRIES: readonly string[] = ["US"];

/**
 * The stored-card terms an account has to have accepted to count as current.
 * Bumping this string is what makes every existing consent row stale, which is
 * the whole mechanism — consents are append-only, so nothing is rewritten and
 * the evidence that the old terms were accepted survives the bump.
 */
export const CURRENT_STORED_CARD_TERMS_VERSION = "v1";

/** How close to its expiry a card has to be before the panel mentions it. */
export const CARD_EXPIRING_WINDOW_DAYS = 45;

/** Purchases per rolling 24 hours before `cap_reached`, absent an override. */
export const DEFAULT_DAILY_ORDER_CAP = 5;

/** A saved card as this module needs to see it. Display metadata only. */
export interface PurchasingPaymentMethodFacts {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  detachedAt: Date | null;
}

/**
 * The card the panel names. Brand, last four and expiry are outside PCI scope;
 * there is nothing else about a card this server is permitted to know.
 */
export interface PurchasingCard {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * The narrowest thing that can render a "ships to" line: a country, because
 * the destination decides whether a sale is possible at all, and a postal code,
 * because it is what a human recognises as their own address.
 *
 * The recipient's name, the street lines and the city are deliberately absent.
 * They exist in `user_shipping_addresses` and they go nowhere near a response.
 */
export interface PurchasingShipsTo {
  country: string;
  postalCode: string;
}

export interface PurchasingSnapshot {
  /** The headline: the highest-ranked entry of `reasons`, or `ready`. */
  state: PurchasingState;
  /**
   * Everything true about this account, most blocking first. An array because
   * real accounts are `not_configured` *and* `consent_stale`, and a panel that
   * fixes one of those and leaves the other unmentioned sends the buyer round
   * the loop a second time.
   */
  reasons: PurchasingState[];
  card: PurchasingCard | null;
  shipsTo: PurchasingShipsTo | null;
  /** The terms version this account accepted, or null if it never has. */
  consentVersion: string | null;
}

export interface PurchasingFacts {
  commerceEnabled: boolean;
  authenticated: boolean;
  /** The live (un-archived) address, or null. Archived rows are not facts here. */
  address: { country: string; postalCode: string } | null;
  /**
   * Every payment-method row for the account, detached ones included, most
   * recent first. The detached rows are what distinguishes "never had a card"
   * from "the card was removed", and those get different copy.
   */
  paymentMethods: readonly PurchasingPaymentMethodFacts[];
  /** The most recent consent, or null. */
  consent: { termsVersion: string } | null;
  currentTermsVersion: string;
  /**
   * Orders in the last rolling 24 hours that represent a real charge ATTEMPT,
   * not only the settled ones. An order sitting at `pending_payment` or
   * `authenticating` has a card behind it and a webhook still to arrive;
   * counting only `paid` would let a burst fired in the seconds before any of
   * them settles pass the cap once per request, which is precisely the shape of
   * runaway the cap exists to brake.
   */
  chargeableOrdersLast24h: number;
  dailyOrderCap: number;
  supportedCountries: readonly string[];
  now: Date;
}

/**
 * The card a charge would actually use: the default if one is marked, otherwise
 * the most recent one still attached. Detached rows can never be selected —
 * charging one is a guaranteed failure at Stripe.
 *
 * A row with no `last4` is skipped for the same reason. That is the marker of
 * a payment method Stripe handed back with no `card` object at all — a bank
 * debit, a wallet — which reached the table before the save path refused
 * anything but a card, and which the purchase path cannot charge: it confirms
 * on-session as though it were a card and raises an error that is not a
 * decline, so the buyer gets a 500 rather than an answer.
 *
 * Skipping it turns an unrecoverable state into an actionable one. The account
 * derives `pm_detached` or `needs_payment_method` and the panel says to add a
 * payment method, which is exactly what is wrong and exactly what fixes it.
 * Selecting an instrument that cannot be charged is worse than having none,
 * because the account reads as `ready` right up to the till.
 */
function selectCard(
  paymentMethods: readonly PurchasingPaymentMethodFacts[],
): PurchasingPaymentMethodFacts | null {
  const usable = paymentMethods.filter((pm) => pm.detachedAt === null && pm.last4 !== null);
  return usable.find((pm) => pm.isDefault) ?? usable[0] ?? null;
}

/**
 * The instant a card stops working: the start of the month AFTER the one
 * printed on it, because a card is good through the last day of its expiry
 * month. `Date.UTC` takes a zero-based month, so passing the printed (one-based)
 * month lands on the following one, and December rolls the year for free.
 *
 * UTC, not local time, because the answer must not depend on which server
 * happens to be answering. It can therefore call a card expired a few hours
 * before midnight in the buyer's own timezone, which is the safe direction:
 * Stripe decides whether a charge succeeds, and this state only decides what
 * the panel says.
 *
 * Returns null when the expiry is unknown or nonsense — a row whose month is
 * outside 1-12 tells us nothing, and inventing an expiry from it would either
 * block a working card or bless a dead one.
 */
function expiresAt(card: PurchasingCard): number | null {
  const { expMonth, expYear } = card;
  if (expMonth === null || expYear === null) return null;
  if (!Number.isInteger(expMonth) || !Number.isInteger(expYear)) return null;
  if (expMonth < 1 || expMonth > 12) return null;
  return Date.UTC(expYear, expMonth, 1);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function classifyExpiry(
  card: PurchasingCard,
  now: Date,
  windowDays: number,
): "expired" | "expiring" | "ok" | "unknown" {
  const end = expiresAt(card);
  if (end === null) return "unknown";
  const remaining = end - now.getTime();
  if (remaining <= 0) return "expired";
  return remaining <= windowDays * DAY_MS ? "expiring" : "ok";
}

/**
 * Reads the daily purchase cap out of its raw environment value.
 *
 * Split out and taking the raw string so the parsing is testable without
 * mutating `process.env`. Anything that is not a positive integer falls back to
 * the default rather than disabling the cap: a typo in a limit must not become
 * "no limit".
 */
export function resolveDailyOrderCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DAILY_ORDER_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_DAILY_ORDER_CAP;
  return parsed;
}

/**
 * True when nothing on the account stands between the buyer and a charge.
 *
 * Written against `reasons` rather than against `state` so that a new blocking
 * reason is refused by default. If this tested `state !== "ready"` instead,
 * adding a state and forgetting this line would silently make it buyable.
 */
export function isPurchasable(snapshot: PurchasingSnapshot): boolean {
  return snapshot.reasons.every((reason) => ADVISORY_REASONS.has(reason));
}

export function derivePurchasingState(facts: PurchasingFacts): PurchasingSnapshot {
  // Both of these short-circuit before anything is read off the account,
  // because in neither case is there an account state worth describing — and
  // when the surface is off, the tables backing these facts may not even exist.
  if (!facts.commerceEnabled) {
    return { state: "disabled", reasons: ["disabled"], card: null, shipsTo: null, consentVersion: null };
  }
  if (!facts.authenticated) {
    return { state: "anonymous", reasons: ["anonymous"], card: null, shipsTo: null, consentVersion: null };
  }

  const selected = selectCard(facts.paymentMethods);
  const card: PurchasingCard | null = selected
    ? {
        brand: selected.brand,
        last4: selected.last4,
        expMonth: selected.expMonth,
        expYear: selected.expYear,
      }
    : null;
  const shipsTo: PurchasingShipsTo | null = facts.address
    ? { country: facts.address.country, postalCode: facts.address.postalCode }
    : null;
  const consentVersion = facts.consent?.termsVersion ?? null;

  // Pushed in rank order, so `reasons[0]` is the headline without a sort.
  const reasons: PurchasingState[] = [];

  const everHadCard = facts.paymentMethods.length > 0;
  if (!facts.address && !everHadCard) {
    // One reason, not two: an account that has never set anything up is not
    // usefully told that it is missing an address *and* missing a card.
    reasons.push("not_configured");
  } else {
    if (!facts.address) {
      reasons.push("needs_address");
    } else if (!isSupportedDestination(facts.address.country, facts.supportedCountries)) {
      reasons.push("unsupported_destination");
    }
    if (!card) {
      reasons.push(everHadCard ? "pm_detached" : "needs_payment_method");
    }
  }

  const expiry = card ? classifyExpiry(card, facts.now, CARD_EXPIRING_WINDOW_DAYS) : "unknown";
  if (expiry === "expired") reasons.push("card_expired");

  if (consentVersion !== facts.currentTermsVersion) reasons.push("consent_stale");

  if (facts.chargeableOrdersLast24h >= facts.dailyOrderCap) reasons.push("cap_reached");

  if (expiry === "expiring") reasons.push("card_expiring");

  return { state: reasons[0] ?? "ready", reasons, card, shipsTo, consentVersion };
}

/**
 * Country comparison is case-folded because ISO 3166-1 alpha-2 is written both
 * ways in the wild and "us" is not a different country from "US".
 */
function isSupportedDestination(country: string, supported: readonly string[]): boolean {
  const wanted = country.trim().toUpperCase();
  return supported.some((c) => c.trim().toUpperCase() === wanted);
}
