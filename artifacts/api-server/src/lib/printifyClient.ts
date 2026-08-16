import { createRateLimiter } from "./rateLimit";

/**
 * The Printify adapter: the only place in the server that talks to the print
 * provider, and the only place that knows which shop KAX manufactures in.
 *
 * Its shape is `stripeClient.ts`'s shape, deliberately — an env gate that makes
 * the whole surface inert until an operator turns it on, plus a client
 * constructed per call rather than held in a module variable, so a rotated
 * token is picked up without a redeploy. Neither the token nor the shop id is
 * read anywhere else.
 *
 * ## The shop is configuration, and there is no fallback
 *
 * `KAX_PRINTIFY_SHOP_ID` comes from the environment and the client refuses to
 * be constructed without it. There is deliberately no listing call anywhere in
 * this file, and "the first shop the account returns" is not a default this
 * adapter is allowed to have: the account's shop list still contains an old
 * Shopify-channel store, so a fallback would not fail — it would quietly
 * publish KAX's manufacturing into somebody else's storefront, which is the
 * failure mode that is hardest to notice and hardest to unwind. The real value
 * is not written down here either; hard-coding it is the same bug wearing a
 * better number. A test greps this file's source to keep both out.
 *
 * ## Writes are never retried
 *
 * `partnerClient.ts` retries 429s and 5xxs because a repeated GET costs
 * nothing. Every call here is a write against a manufacturer: a retried
 * submission whose first attempt actually landed is a second parcel, printed
 * and paid for. So a failed call is reported to the operator, who can look at
 * the order in Printify's own UI and press the button again. `external_id`
 * carries the order's `client_reference` precisely so that a submission whose
 * response was lost can still be found by name on Printify's side.
 *
 * ## The buyer's address
 *
 * `addressToFromSnapshot` takes the order's `ship_to_*` snapshot and nothing
 * else — its parameter type has no user id in it, so this module has no way to
 * reach a live `users` or `user_shipping_addresses` row even by accident. That
 * is the postal-PII rule made structural rather than promised: the address that
 * goes to the printer is the one the buyer paid against, and a later address
 * edit cannot rewrite where an already-shipped parcel went.
 *
 * Nothing here logs. Not the token, not the address, and not a provider error
 * body — see `toPrintifyError`.
 */

export const PRINTIFY_API_BASE = "https://api.printify.com/v1";

/**
 * Master switch for the fulfilment surface. With this unset (or "0") the two
 * admin endpoints answer 404 as if they had never been mounted, which is the
 * same inert-until-configured idiom `commerceEnabled()` gives the checkout.
 */
export function printifyEnabled(): boolean {
  const v = process.env["KAX_PRINTIFY_ENABLED"];
  return v === "1" || v === "true";
}

/**
 * A credential that is present but empty is not a credential. `""` reaches an
 * `Authorization` header as a well-formed bearer of nothing, so it is collapsed
 * to "absent" at the boundary and refused there.
 */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** The adapter cannot be built from this environment. Never carries the token. */
export class PrintifyNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintifyNotConfiguredError";
  }
}

/**
 * Printify refused, or could not be reached.
 *
 * `code` is Printify's own numeric error code when it sent one. There is no
 * `body` field on purpose — see `toPrintifyError`.
 */
export class PrintifyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PrintifyError";
  }
}

export interface PrintifyConfig {
  token: string;
  shopId: string;
}

/**
 * Read the adapter's configuration, or refuse.
 *
 * Both halves are required and neither has a default. The shop id is checked
 * for being all digits as well as present, because the one thing worse than an
 * unset shop is a plausible-looking wrong one — a store name typed where an id
 * belongs would otherwise be discovered as a 404 from Printify at the moment an
 * operator was trying to fulfil a paid order.
 */
export function getPrintifyConfig(): PrintifyConfig {
  const token = present(process.env["KAX_PRINTIFY_API_TOKEN"]);
  if (!token) {
    throw new PrintifyNotConfiguredError("KAX_PRINTIFY_API_TOKEN is not configured");
  }
  const shopId = present(process.env["KAX_PRINTIFY_SHOP_ID"]);
  if (!shopId) {
    throw new PrintifyNotConfiguredError("KAX_PRINTIFY_SHOP_ID is not configured");
  }
  if (!/^\d+$/.test(shopId)) {
    throw new PrintifyNotConfiguredError("KAX_PRINTIFY_SHOP_ID must be a numeric shop id");
  }
  return { token, shopId };
}

/** `address_to`, in Printify's own field names. */
export interface PrintifyAddress {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  country: string;
  region: string;
  address1: string;
  address2?: string;
  city: string;
  zip: string;
}

/** One printed thing. Quantities and variants beyond one are not in v0.1. */
export interface PrintifyLineItem {
  product_id: string;
  variant_id: number;
  quantity: number;
}

export interface PrintifySubmitOrderInput {
  /** The order's `client_reference`. Printify's second name for our row. */
  externalId: string;
  /** What the order is called in Printify's own UI. */
  label: string;
  lineItems: PrintifyLineItem[];
  addressTo: PrintifyAddress;
}

/** As much of a Printify order as this adapter reads back. */
export interface PrintifyOrderRef {
  id: string;
  status: string | null;
}

export interface PrintifyClient {
  /** The shop every call below is scoped to. Exposed so callers can report it. */
  readonly shopId: string;
  submitOrder(input: PrintifySubmitOrderInput): Promise<PrintifyOrderRef>;
  sendToProduction(printifyOrderId: string): Promise<PrintifyOrderRef>;
}

/**
 * Printify publishes a 600 requests/minute global ceiling and counts an error
 * rate above 5% of total requests as a violation in its own right, so the
 * adapter refuses locally before it can contribute to either. The ceiling is
 * per integration and the api-server is a single instance, which is what makes
 * an in-memory limiter the right shape here — the same reasoning
 * `rateLimit.ts` records for the auth limiters.
 *
 * One bucket, not one per caller: the limit being defended is Printify's view
 * of us, and that is a single number no matter who pressed the button.
 */
const outboundLimiter = createRateLimiter({ limit: 500, windowMs: 60_000 });
const OUTBOUND_KEY = "printify";

/**
 * Turn a refusal into an error that is safe to let out of this module.
 *
 * Printify's 4xx bodies carry a generic top-level `message` next to an `errors`
 * object that quotes the offending field back — which, on a rejected address,
 * means the buyer's street. `errors` is therefore dropped at this boundary and
 * never reaches the caller, a log line, or an HTTP response. The status and
 * Printify's numeric code survive because they are what an operator needs to
 * look the order up in Printify's own UI, where the detail belongs.
 */
function toPrintifyError(status: number, rawBody: string): PrintifyError {
  let code: number | null = null;
  let message = `Printify request failed with ${status}`;
  try {
    const parsed = JSON.parse(rawBody) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "number") code = parsed.code;
    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      message = `Printify: ${parsed.message.slice(0, 200)}`;
    }
  } catch {
    // A body that is not JSON is a gateway or a proxy talking, not Printify.
    // There is nothing in it worth carrying and possibly plenty worth not.
  }
  return new PrintifyError(status, code, message);
}

async function printifyFetch(
  config: PrintifyConfig,
  path: string,
  body: unknown,
): Promise<unknown> {
  if (!outboundLimiter.hit(OUTBOUND_KEY)) {
    throw new PrintifyError(429, null, "Printify request budget for this minute is spent");
  }

  let res: Response;
  try {
    res = await fetch(`${PRINTIFY_API_BASE}${path}`, {
      method: "POST",
      // Bound the call so a hung connection cannot hold the row lock the
      // caller took out over this submission for the rest of the process's
      // life.
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A transport failure is genuinely ambiguous on a write: the order may
    // have been created and only the answer lost. Saying so is the whole
    // value of this branch — it is why the operator checks Printify before
    // pressing the button a second time.
    throw new PrintifyError(
      0,
      null,
      `Printify could not be reached (${err instanceof Error ? err.name : "unknown error"})`,
    );
  }

  const text = await res.text();
  if (!res.ok) throw toPrintifyError(res.status, text);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PrintifyError(res.status, null, "Printify returned a body that is not JSON");
  }
}

function readOrderRef(payload: unknown, fallbackId?: string): PrintifyOrderRef {
  const obj = (typeof payload === "object" && payload !== null ? payload : {}) as {
    id?: unknown;
    status?: unknown;
  };
  const id = typeof obj.id === "string" ? obj.id : typeof obj.id === "number" ? String(obj.id) : fallbackId;
  if (!id) {
    // Without an id there is nothing to write on the row, and an order we
    // cannot name is an order we would submit again. Fail loudly instead.
    throw new PrintifyError(502, null, "Printify accepted the order without returning an id");
  }
  return { id, status: typeof obj.status === "string" ? obj.status : null };
}

/**
 * A fresh Printify client.
 *
 * Not cached — the configuration is read on every call, the same way
 * `getUncachableStripeClient()` reads its credentials, so a rotated token or a
 * corrected shop id takes effect on the next request rather than on the next
 * restart. Throws `PrintifyNotConfiguredError` when either half is missing;
 * callers turn that into a 503 rather than a 500, because it is a fact about
 * the deployment and not about the order.
 */
export function getUncachablePrintifyClient(): PrintifyClient {
  const config = getPrintifyConfig();

  return {
    shopId: config.shopId,

    async submitOrder(input: PrintifySubmitOrderInput): Promise<PrintifyOrderRef> {
      const payload = await printifyFetch(config, `/shops/${config.shopId}/orders.json`, {
        external_id: input.externalId,
        label: input.label,
        line_items: input.lineItems,
        // Standard shipping. It is the service the product's `shipping_cents`
        // was quoted for, so anything else here would ship an order the buyer
        // did not pay for.
        shipping_method: 1,
        // KAX is the merchant of record and the only party that has spoken to
        // this buyer. A second, differently-worded shipping mail from a
        // manufacturer they have never heard of is not a service to them.
        send_shipping_notification: false,
        address_to: input.addressTo,
      });
      return readOrderRef(payload);
    },

    async sendToProduction(printifyOrderId: string): Promise<PrintifyOrderRef> {
      const payload = await printifyFetch(
        config,
        `/shops/${config.shopId}/orders/${encodeURIComponent(printifyOrderId)}/send_to_production.json`,
        {},
      );
      return readOrderRef(payload, printifyOrderId);
    },
  };
}

/**
 * The address columns of a `commerce_orders` row, and nothing else.
 *
 * This type is the guarantee. `addressToFromSnapshot` cannot be handed a user
 * id or a database handle, so it cannot resolve the buyer's current address
 * even if somebody later decides that would be convenient — the only thing it
 * can turn into `address_to` is what was copied onto the order at charge time.
 */
export interface CommerceOrderShippingSnapshot {
  shipToName: string;
  shipToLine1: string;
  shipToLine2: string | null;
  shipToCity: string;
  shipToRegion: string;
  shipToPostalCode: string;
  shipToCountry: string;
  shipToPhone: string | null;
}

/**
 * One name column, two name fields.
 *
 * The snapshot holds the name as the buyer typed it and Printify wants it in
 * halves, so the first whitespace-separated token becomes the given name and
 * the remainder the family name. A single-word name is sent as both halves
 * rather than leaving one empty: it reads oddly on a packing slip and it
 * arrives, which is the correct trade for an address field.
 */
function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Build `address_to` from the order's own snapshot.
 *
 * There is no email in the snapshot, and reading the buyer's from `users` is
 * exactly the live join this path forbids, so what goes out is the merchant's
 * own contact address from configuration when one is set — never the buyer's.
 * Nothing is lost by that: `send_shipping_notification` is false, so Printify
 * mails no one about this order at all.
 */
export function addressToFromSnapshot(snapshot: CommerceOrderShippingSnapshot): PrintifyAddress {
  const { first, last } = splitName(snapshot.shipToName);
  const contactEmail = present(process.env["KAX_PRINTIFY_CONTACT_EMAIL"]);
  return {
    first_name: first,
    last_name: last,
    ...(contactEmail ? { email: contactEmail } : {}),
    ...(snapshot.shipToPhone ? { phone: snapshot.shipToPhone } : {}),
    country: snapshot.shipToCountry,
    region: snapshot.shipToRegion,
    address1: snapshot.shipToLine1,
    ...(snapshot.shipToLine2 ? { address2: snapshot.shipToLine2 } : {}),
    city: snapshot.shipToCity,
    zip: snapshot.shipToPostalCode,
  };
}
