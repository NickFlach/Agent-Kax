/**
 * The client half of the purchasing settings desk: the words for each derived
 * state, the shape of the two forms, and the five calls the card makes.
 *
 * Everything here is deliberately free of React and free of Stripe. The card
 * component is a rendering problem; the things worth testing about it — which
 * states have copy, when the save button is allowed to fire, what a Stripe
 * address turns into on the wire — are decisions, and they live where a Node
 * test can call them directly rather than where a test would have to mount a
 * DOM and an iframe to reach them.
 *
 * ## The state vocabulary is the server's
 *
 * `PURCHASING_STATE_COPY` is keyed by `PurchasingStateCode`, which is generated
 * from the OpenAPI schema, which is generated from `lib/purchasingState.ts`.
 * The card never decides what state an account is in — it renders the one
 * `GET /me` reported, and every mutation below answers with a freshly derived
 * snapshot so the header can move without a reload. A state the server can
 * reach and this file has no copy for is a blank header, so
 * `purchasing.test.ts` compares the two lists as source.
 *
 * ## Nothing here ever sees a card
 *
 * `savePaymentMethod` takes a SetupIntent id and posts that. It does not accept
 * a `pm_...`, it does not accept a token, and there is no field on any request
 * body in this file that a card number could be put into — which is what makes
 * "card data never reaches our server" a property of the module rather than a
 * rule everyone has to remember.
 */

import type { PurchasingSnapshot, PurchasingStateCode } from "@workspace/api-client-react";
import { appUrl } from "./urls";

// ---------------------------------------------------------------------------
// What the header says
// ---------------------------------------------------------------------------

export interface PurchasingStateCopy {
  /** The badge beside the card title. Short enough to sit on one line. */
  headline: string;
  /** One sentence saying what, if anything, the buyer has to do next. */
  detail: string;
  /**
   * Whether an account in this state can buy right now. Mirrors the server's
   * `isPurchasable`, which is written against `reasons` rather than `state`:
   * `advisory` is the one non-blocking reason there is.
   */
  tone: "ok" | "advisory" | "blocked" | "off";
}

/**
 * The twelve states of `lib/purchasingState.ts`, in the server's own rank
 * order, each with the sentence the desk shows for it.
 *
 * The copy answers "what do I do now", not "what is wrong", because every one
 * of these except `ready` and `card_expiring` is something the buyer is being
 * asked to fix. `unsupported_destination` is the exception that says so
 * plainly: it is the one blocked state this panel cannot clear.
 */
export const PURCHASING_STATE_COPY: Record<PurchasingStateCode, PurchasingStateCopy> = {
  disabled: {
    headline: "Unavailable",
    detail: "Physical purchasing is not switched on for this deployment.",
    tone: "off",
  },
  anonymous: {
    headline: "Signed out",
    detail: "Sign in to set up physical purchasing.",
    tone: "off",
  },
  not_configured: {
    headline: "Not set up",
    detail: "Add a shipping address and a card to buy physical items.",
    tone: "blocked",
  },
  unsupported_destination: {
    headline: "Can't ship there",
    detail:
      "We can't send parcels to the country on your saved address yet. Nothing on this panel will change that — saving a card won't help.",
    tone: "blocked",
  },
  needs_address: {
    headline: "Address needed",
    detail: "Your card is on file. Add a shipping address to finish.",
    tone: "blocked",
  },
  needs_payment_method: {
    headline: "Card needed",
    detail: "Your address is on file. Add a card to finish.",
    tone: "blocked",
  },
  pm_detached: {
    headline: "Card removed",
    detail: "The card that was on this account is gone. Add another one to buy again.",
    tone: "blocked",
  },
  card_expired: {
    headline: "Card expired",
    detail: "The card on file is past its expiry month. Replace it to buy again.",
    tone: "blocked",
  },
  consent_stale: {
    headline: "Terms updated",
    detail: "The stored-card terms have changed since you accepted them. Read and accept them to keep buying.",
    tone: "blocked",
  },
  cap_reached: {
    headline: "Daily limit",
    detail: "You've hit the purchase limit for the last 24 hours. It clears as those orders age out.",
    tone: "blocked",
  },
  card_expiring: {
    headline: "Card expiring",
    detail: "You can still buy. The card on file expires soon — replace it before it does.",
    tone: "advisory",
  },
  ready: {
    headline: "Ready",
    detail: "An address, a card and accepted terms. You can buy physical items.",
    tone: "ok",
  },
};

/**
 * What the desk says about a state it has never heard of.
 *
 * Reachable only when the server grows a thirteenth state and this file has not
 * caught up. It is a sentence rather than a crash or an empty header because a
 * settings panel that renders nothing is a panel the buyer reports as broken,
 * and because the states this could be are all blocking ones — the safe thing
 * to say is "you cannot buy yet", never "you are ready".
 */
export const UNKNOWN_PURCHASING_STATE_COPY: PurchasingStateCopy = {
  headline: "Unavailable",
  detail: "Purchasing is unavailable right now. Reload the page, and get in touch if it persists.",
  tone: "blocked",
};

/**
 * The copy for a state code, taking a plain string on purpose.
 *
 * The value arrives over the wire, so the type says `PurchasingStateCode` and
 * reality says "whatever the server sent". Indexing a `Record` with an unknown
 * key yields `undefined`, and reading `.headline` off that is the blank card
 * this fallback exists to prevent.
 */
export function purchasingCopy(state: string): PurchasingStateCopy {
  const table = PURCHASING_STATE_COPY as Record<string, PurchasingStateCopy | undefined>;
  return table[state] ?? UNKNOWN_PURCHASING_STATE_COPY;
}

/** The saved card as one line: "Visa •••• 4242 · exp 04/2029". */
export function formatSavedCard(card: PurchasingSnapshot["card"]): string {
  if (!card) return "No card on file";
  const brand = card.brand ? card.brand.replace(/^./, (c) => c.toUpperCase()) : "Card";
  const digits = card.last4 ? `•••• ${card.last4}` : "•••• ????";
  if (card.expMonth === null || card.expYear === null) return `${brand} ${digits}`;
  return `${brand} ${digits} · exp ${String(card.expMonth).padStart(2, "0")}/${card.expYear}`;
}

// ---------------------------------------------------------------------------
// The consent gate
// ---------------------------------------------------------------------------

export interface SaveCardGate {
  /** The consent checkbox, as it is right now in the browser. */
  consentAccepted: boolean;
  /** The terms document has arrived, so there is a version to accept. */
  termsLoaded: boolean;
  /** Stripe.js resolved and the Elements provider is mounted. */
  stripeReady: boolean;
  /** A save is already in flight. */
  busy: boolean;
}

/**
 * Whether the "Save card" button may fire.
 *
 * Consent is first and it is not negotiable: the terms say what we may do with
 * a stored card, and confirming a SetupIntent for an account that has not
 * accepted them saves a card we have no recorded permission to charge. The
 * server refuses a purchase in that state anyway (`consent_stale`), so a UI
 * that let the card be saved would only have collected an instrument nobody
 * could use — but the reason to gate here is the agreement, not the refusal.
 *
 * `termsLoaded` is part of the gate rather than a separate check because
 * accepting is `POST /consent { termsVersion }`, and there is no version to
 * send until the document that carries it has arrived.
 */
export function canSaveCard(gate: SaveCardGate): boolean {
  return gate.consentAccepted && gate.termsLoaded && gate.stripeReady && !gate.busy;
}

// ---------------------------------------------------------------------------
// The address form
// ---------------------------------------------------------------------------

/**
 * The address as this client holds it, in the server's field names.
 *
 * Named for `PUT /me/purchasing/address` rather than for Stripe: `region` not
 * `state`, `postalCode` not `postal_code`. The translation happens once, in
 * `addressDraftFromElement`, so the rest of the card never has to hold both
 * vocabularies at the same time.
 *
 * This object is PII. It is never logged, never put in a toast, and never sent
 * anywhere but the address PUT.
 */
export interface ShippingAddressDraft {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
  /** Stripe's Address Element reported the entry complete. */
  validated: boolean;
}

export const EMPTY_ADDRESS_DRAFT: ShippingAddressDraft = {
  name: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  phone: "",
  validated: false,
};

/**
 * The subset of Stripe's Address Element value this app reads.
 *
 * Declared locally rather than imported from `@stripe/stripe-js` so that this
 * module — and therefore its test — stays free of a package that expects a
 * browser. The card passes the real `StripeAddressElementChangeEvent["value"]`
 * in; structural typing does the rest.
 */
export interface StripeAddressValue {
  name?: string;
  phone?: string;
  address: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  };
}

/**
 * Stripe's address, in our field names.
 *
 * `complete` is carried through as `validated` and is NOT recomputed from the
 * fields. It is Stripe's own verdict on its own form — it accounts for the
 * per-country rules about which fields are required and for whether an
 * autocomplete suggestion was actually taken — and re-deriving it here would
 * replace that with a guess that happens to agree most of the time.
 */
export function addressDraftFromElement(
  value: StripeAddressValue,
  complete: boolean,
): ShippingAddressDraft {
  const a = value.address;
  return {
    name: value.name ?? "",
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    city: a.city ?? "",
    region: a.state ?? "",
    postalCode: a.postal_code ?? "",
    // Upper-cased here as well as on the server. The server is what decides,
    // but `SUPPORTED_SHIP_TO_COUNTRIES` is compared case-folded in one place
    // and case-sensitively in another (`AddressBody` uppercases before the
    // `.includes`), and sending the canonical form means the client never
    // depends on which.
    country: (a.country ?? "").trim().toUpperCase(),
    phone: value.phone ?? "",
    validated: complete,
  };
}

/**
 * Whether the draft has everything `AddressBody` marks required.
 *
 * Deliberately NOT the same question as `draft.validated`. Stripe reports
 * `complete` only when every field it is configured to collect is filled —
 * which, with the phone field switched on, includes one the server treats as
 * optional. An address that is savable but not validated is a real and normal
 * state: it goes to the courier with a null `validated_at`, which is the honest
 * record of "the buyer typed it and nothing checked it".
 */
export function addressDraftIsSavable(draft: ShippingAddressDraft): boolean {
  return (
    draft.name.trim() !== "" &&
    draft.line1.trim() !== "" &&
    draft.city.trim() !== "" &&
    draft.region.trim() !== "" &&
    draft.postalCode.trim() !== "" &&
    draft.country.trim() !== ""
  );
}

/**
 * The address PUT body.
 *
 * Optional lines go as null rather than "" — the server stores them the same
 * way and `AddressBody` accepts either, but sending the empty string means the
 * request says "there is a second line, and it is blank".
 */
export function addressRequestBody(draft: ShippingAddressDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    line1: draft.line1.trim(),
    line2: draft.line2.trim() || null,
    city: draft.city.trim(),
    region: draft.region.trim(),
    postalCode: draft.postalCode.trim(),
    country: draft.country.trim().toUpperCase(),
    phone: draft.phone.trim() || null,
    validated: draft.validated,
  };
}

// ---------------------------------------------------------------------------
// The five calls
// ---------------------------------------------------------------------------

/** What `GET /me/purchasing/terms` serves. */
export interface PurchasingTerms {
  version: string;
  sha256: string;
  markdown: string;
  /**
   * The destinations the server will accept, from its own
   * `SUPPORTED_SHIP_TO_COUNTRIES`. The Address Element is restricted to this
   * list rather than to a literal in the client, so the countries offered and
   * the countries accepted are one value.
   */
  supportedCountries: string[];
}

/** Cache key for the terms document. It changes only when the server does. */
export const PURCHASING_TERMS_QUERY_KEY = ["purchasing", "terms"] as const;

/**
 * The server's `{ error }` out of a failed response, or a fallback.
 *
 * Field-level `issues` are folded in for the address form, and they are safe to
 * show: `AddressBody`'s messages describe the constraint ("Required", "must not
 * contain control characters") and never the submitted value, which is what
 * keeps a home address out of a string that ends up in a toast or a console.
 * Nothing in this file ever puts a draft field into a message.
 */
async function readPurchasingError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: unknown;
      issues?: Array<{ path?: unknown; message?: unknown }>;
    };
    const head = typeof body.error === "string" && body.error ? body.error : fallback;
    const issues = Array.isArray(body.issues)
      ? body.issues
          .filter((i) => typeof i.path === "string" && typeof i.message === "string")
          .map((i) => `${String(i.path)}: ${String(i.message)}`)
      : [];
    return issues.length > 0 ? `${head} (${issues.join("; ")})` : head;
  } catch {
    return fallback;
  }
}

async function purchasingRequest(
  path: string,
  init: RequestInit,
  fallback: string,
): Promise<unknown> {
  const res = await fetch(appUrl(`/api/me/purchasing${path}`), {
    credentials: "include",
    ...init,
  });
  if (!res.ok) throw new Error(await readPurchasingError(res, fallback));
  return res.json();
}

function jsonBody(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Every mutation answers with the account's freshly derived state, so the one
 * thing a caller ever wants back is that snapshot.
 */
function snapshotOf(payload: unknown): PurchasingSnapshot {
  return (payload as { purchasing: PurchasingSnapshot }).purchasing;
}

export async function fetchPurchasingTerms(): Promise<PurchasingTerms> {
  const payload = (await purchasingRequest(
    "/terms",
    { method: "GET" },
    "Could not load the stored-card terms.",
  )) as PurchasingTerms;
  return {
    ...payload,
    // Older servers did not send this. An empty list means "do not restrict",
    // which is what the Address Element does with `allowedCountries` omitted —
    // and the PUT still refuses anything the server does not ship to, so the
    // fallback loses a hint, never a guarantee.
    supportedCountries: Array.isArray(payload.supportedCountries) ? payload.supportedCountries : [],
  };
}

/**
 * Ask for a SetupIntent and get back its client secret — never a customer id,
 * never a payment method id. The server keeps both.
 */
export async function createSetupIntent(): Promise<string> {
  const payload = (await purchasingRequest(
    "/setup-intent",
    { method: "POST", ...jsonBody({}) },
    "Could not start saving the card.",
  )) as { clientSecret: string | null };
  if (!payload.clientSecret) throw new Error("Stripe did not return a client secret.");
  return payload.clientSecret;
}

/**
 * Save the card that a confirmed SetupIntent points at.
 *
 * The argument is the SetupIntent id and there is no overload that takes a
 * payment method. The server fetches the intent from Stripe, checks its
 * Customer against this account's, and reads the card off it — so the only
 * thing this call can ever attach is a card the caller just confirmed.
 */
export async function savePaymentMethod(setupIntentId: string): Promise<PurchasingSnapshot> {
  return snapshotOf(
    await purchasingRequest(
      "/payment-method",
      { method: "POST", ...jsonBody({ setupIntentId }) },
      "Could not save the card.",
    ),
  );
}

export async function saveShippingAddress(
  draft: ShippingAddressDraft,
): Promise<PurchasingSnapshot> {
  return snapshotOf(
    await purchasingRequest(
      "/address",
      { method: "PUT", ...jsonBody(addressRequestBody(draft)) },
      "Could not save the address.",
    ),
  );
}

/**
 * Record acceptance of the terms the desk displayed.
 *
 * The version is sent so the server can refuse consent to a document this
 * client never showed; what gets written is the server's own constant and the
 * digest of its own copy. See `POST /me/purchasing/consent`.
 */
export async function acceptStoredCardTerms(termsVersion: string): Promise<PurchasingSnapshot> {
  return snapshotOf(
    await purchasingRequest(
      "/consent",
      { method: "POST", ...jsonBody({ termsVersion }) },
      "Could not record your acceptance.",
    ),
  );
}

/**
 * Remove the saved card. No id is sent: the server removes the one it would
 * have charged, which is the one this panel was calling your card.
 */
export async function removePaymentMethod(): Promise<PurchasingSnapshot> {
  return snapshotOf(
    await purchasingRequest("/payment-method", { method: "DELETE" }, "Could not remove the card."),
  );
}
