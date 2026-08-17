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
 * ## …and `findOrderByExternalId` is what makes "found by name" a call
 *
 * The sentence above was true and unreachable: `external_id` was written on
 * every submission and nothing in this adapter could read it back, so "look it
 * up in Printify's UI" was the only way to act on it and only a human could.
 * `findOrderByExternalId` pages the shop's order list and matches that value
 * exactly, which turns "the order may exist and we cannot name it" from a dead
 * end into a question with an answer. `commerceFulfillmentWorker.ts` asks it
 * before every submission; see `PrintifyAmbiguousSubmissionError`.
 *
 * **What it matches on is `metadata.shop_order_label`, and that is not a
 * detail.** A live response was captured from `GET /v1/shops/{id}/orders.json`
 * and there is no top-level `external_id` in it — not in the list projection
 * and not in the detail projection either. The keys each listed order actually
 * carries are `id, app_order_id, shop_id, address_to, line_items, metadata,
 * total_price, total_shipping, total_tax, status, shipping_method, created_at,
 * sent_to_production_at, fulfilment_type, printify_connect,
 * sales_channel_type_id`. The value we POST as `external_id` comes back inside
 * `metadata`, as `shop_order_label`. An earlier version of this function read
 * `row.external_id`, which is `undefined` on every row Printify returns — so
 * every page yielded no match, the scan ran to the declared last page, and the
 * function answered `null`, meaning "definitively absent", to a caller whose
 * next step was to POST the order again. That did not reduce the chance of a
 * duplicate parcel; it made one certain, and reported success while doing it.
 * `external_id` is still read as a FALLBACK, because it costs nothing and
 * another Printify plan or a future API version may populate it.
 *
 * It is a read, so it may be retried freely — but a lookup that FAILS answers
 * nothing, and a caller must never treat a failed lookup as "not there".
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
  /**
   * Whether this failure leaves it UNKNOWN whether the provider created the
   * order. False for an ordinary refusal — a 400 means nothing was made — and
   * the flag exists so a caller can ask the question structurally rather than
   * by pattern-matching a status code it may not have thought of.
   *
   * A retry policy must never treat an ambiguous failure as retryable: retrying
   * an order that already exists is a second parcel. See the subclass below.
   */
  public readonly ambiguous: boolean = false;

  constructor(
    public readonly status: number,
    public readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PrintifyError";
  }
}

/**
 * The provider may have created this order, and we cannot name it.
 *
 * This is not "the request failed". It is the strictly worse case where the
 * request may well have SUCCEEDED and only the identifier was lost — which is
 * precisely the case where posting the same order again prints a second parcel
 * and charges the merchant's card a second time, against one customer payment.
 *
 * The only correct answer is to find out, by asking Printify for the order
 * under the `external_id` we sent — `findOrderByExternalId`. So this error is
 * deliberately NOT retryable in the sense a 429 is retryable: a caller that
 * catches it may reconcile, and may then submit only if reconciliation proves
 * the order is absent. `commerceFulfillmentWorker.isRetryable` refuses it by
 * name, and the 502 status is not what that refusal hangs on — a genuine 502
 * from Printify is a different fact from this one.
 */
export class PrintifyAmbiguousSubmissionError extends PrintifyError {
  public override readonly ambiguous = true;

  constructor(status: number, code: number | null, message: string) {
    super(status, code, message);
    this.name = "PrintifyAmbiguousSubmissionError";
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

/**
 * One parcel, in the carrier's terms.
 *
 * `deliveredAt` is how delivery is learnt at all: Printify's order lifecycle has
 * no `delivered` status, so a shipment carrying a `delivered_at` is the only
 * evidence there is that the thing arrived.
 */
export interface PrintifyShipment {
  carrier: string | null;
  number: string | null;
  url: string | null;
  /** ISO 8601 as the provider sent it. Not parsed here. */
  deliveredAt: string | null;
}

/**
 * A submitted order, read back — and ONLY the four things we are allowed to
 * keep.
 *
 * The live capture of a Printify order carries `address_to` in every projection,
 * list and detail alike. It is not in this type, so no caller can be handed the
 * buyer's street by this call and no later widening of a log line can acquire
 * one: the reduction happens at the parse boundary in `readOrderState` and the
 * rest of the response is dropped on the floor. `line_items`, `metadata` and the
 * three money fields are not kept either — this adapter is asking one question.
 */
export interface PrintifyOrderState {
  id: string;
  /** Printify's own literal, verbatim. `in-production` is a real observed value. */
  status: string | null;
  shipments: PrintifyShipment[];
}

export interface PrintifyClient {
  /** The shop every call below is scoped to. Exposed so callers can report it. */
  readonly shopId: string;
  submitOrder(input: PrintifySubmitOrderInput): Promise<PrintifyOrderRef>;
  sendToProduction(printifyOrderId: string): Promise<PrintifyOrderRef>;
  /**
   * Find an order by the `external_id` we submitted it under, or prove it is
   * not there. `null` means DEFINITIVELY absent within the pages searched; a
   * search that could not be completed throws instead, because "we did not
   * find it" and "we could not look" must never collapse into the same value
   * on a path whose next step is deciding whether to submit again.
   *
   * "Could not be completed" includes a page this adapter could not PARSE. A
   * page it cannot read is a page it learnt nothing from, and inferring an
   * absence from one is the same false negative as inferring it from a failed
   * request. See `readOrderPage`.
   */
  findOrderByExternalId(externalId: string): Promise<PrintifyOrderRef | null>;
  /**
   * Read one submitted order back, or `null` if Printify does not have it.
   *
   * `null` is returned for a 404 and for NOTHING else. That distinction is the
   * same one `printifyFetch` draws everywhere in this file: a 404 is Printify
   * answering "there is no such order", which is a fact, while a 429, a 500 or a
   * dropped connection is Printify not answering at all — and a poller that read
   * those as "no such order" would be inventing news about somebody's parcel. A
   * failed read throws, and the caller changes nothing.
   */
  getOrder(printifyOrderId: string): Promise<PrintifyOrderState | null>;
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

/**
 * One request to Printify.
 *
 * `method` is a parameter because this adapter now READS as well as writes —
 * `getOrder` asks Printify about an order it already created. It used to be
 * hard-coded to POST, with `body` in the third position, and the first version
 * of `getOrder` therefore posted the string `"GET"` as a JSON body to an order
 * URL. A test asserting the method actually put on the wire is what found that,
 * which is why the assertion is on the wire and not on the call.
 *
 * A GET sends no body and no `Content-Type` — a Content-Type header on a
 * bodyless request is a lie about a request that does not have one.
 */
async function printifyFetch(
  config: PrintifyConfig,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  if (!outboundLimiter.hit(OUTBOUND_KEY)) {
    throw new PrintifyError(429, null, "Printify request budget for this minute is spent");
  }

  let res: Response;
  try {
    res = await fetch(`${PRINTIFY_API_BASE}${path}`, {
      method,
      // Bound the call so a hung connection cannot hold the row lock the
      // caller took out over this submission for the rest of the process's
      // life.
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // A transport failure is genuinely ambiguous on a write: the order may
    // have been created and only the answer lost. Saying so is the whole
    // value of this branch — it is why the operator checks Printify before
    // pressing the button a second time.
    //
    // On a GET it is merely a failed read, and the caller is expected to treat
    // it as such — but status 0 is left the same on both so that a stored
    // `"0:none"` on an order that never got an id is read as ambiguous no
    // matter which call produced it. Under-claiming certainty is free here;
    // over-claiming it costs a parcel.
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
    // We are PAST `res.ok` here, and on the empty-body path we are past it
    // having been handed `{}`. So Printify accepted the request — the order
    // very likely exists — and the one thing we needed back is missing.
    //
    // This is the ambiguous error and not a plain 502, because the difference
    // decides what happens next: a 502 is a refusal a machine may retry, and
    // retrying THIS is posting an order that already exists. The caller
    // reconciles by `external_id` instead.
    throw new PrintifyAmbiguousSubmissionError(
      502,
      null,
      "Printify accepted the order without returning an id",
    );
  }
  return { id, status: typeof obj.status === "string" ? obj.status : null };
}

/**
 * Pages of the shop's order list read before `findOrderByExternalId` gives up.
 *
 * The lookup exists to find a submission made minutes ago, and the shop's list
 * is ASSUMED to be returned newest first — which would put the match on the
 * first page in every case this is called for. That assumption has not been
 * verified: the captured response carries `current_page`/`last_page` and no
 * documented sort order, and nothing here or in the tests establishes one. It
 * is recorded as an assumption on purpose, because if it is wrong the only
 * consequence is a deeper scan, and the code below is written so that a deeper
 * scan is slow rather than wrong: the budget is a bound on a pathological loop,
 * not a search depth anybody is expected to need, and exhausting it THROWS
 * rather than returning "absent". An absence inferred from a search that
 * stopped early is exactly the false negative that gets a second parcel
 * printed. Do not narrow this budget on the strength of the ordering claim
 * until somebody has actually checked it.
 */
const FIND_ORDER_MAX_PAGES = 20;
const FIND_ORDER_PAGE_SIZE = 50;

/** One listed order, reduced to the three things this adapter is allowed to keep. */
interface OrderPageEntry {
  id: string;
  /** `metadata.shop_order_label` — where the value we POST as `external_id` comes back. */
  label: string | null;
  /** A top-level `external_id`, which Printify does not currently send. Fallback only. */
  externalId: string | null;
  status: string | null;
}

/**
 * One page of `GET /shops/{id}/orders.json`, reduced to what we match on.
 *
 * **This function THROWS rather than returning an empty page, and that is the
 * whole point of it.** Its previous shape was `Array.isArray(obj.data) ?
 * obj.data : []`, which turned every unexpected envelope — a bare array, a
 * `{"orders": …}`, an HTML error page that happened to parse, a 200 with `{}` —
 * into a page with no entries. `findOrderByExternalId` then read "no entries"
 * as the end of the list and answered `null`: definitively absent. So a page we
 * could not understand became proof that Printify does not have the order, on
 * the one path whose next step is posting it again.
 *
 * Worse, it contradicted the adapter's own reading of the same value elsewhere:
 * an empty `{}` from the submission POST raises `PrintifyAmbiguousSubmissionError`
 * — "we cannot tell, do not resubmit" — while the same empty `{}` from this GET
 * used to mean "certainly not there, resubmit". One of those had to be wrong,
 * and it was this one.
 *
 * So absence is now only ever concluded from POSITIVE evidence of a well-formed
 * page: `data` an array, and the three pagination fields the live envelope
 * really carries (`current_page`, `last_page`, `total`) all present as numbers.
 * Anything else is a failed read and is reported as one.
 */
function readOrderPage(payload: unknown): {
  entries: OrderPageEntry[];
  currentPage: number;
  lastPage: number;
  total: number;
} {
  const obj = (typeof payload === "object" && payload !== null ? payload : {}) as {
    data?: unknown;
    current_page?: unknown;
    last_page?: unknown;
    total?: unknown;
  };
  const currentPage = typeof obj.current_page === "number" ? obj.current_page : null;
  const lastPage = typeof obj.last_page === "number" ? obj.last_page : null;
  const total = typeof obj.total === "number" ? obj.total : null;
  if (!Array.isArray(obj.data) || currentPage === null || lastPage === null || total === null) {
    // Deliberately says nothing about what WAS there. The body is not quoted
    // back for the same reason `toPrintifyError` drops Printify's `errors`
    // object: an order list is a page of other buyers' addresses.
    throw new PrintifyError(
      502,
      null,
      "Printify order list page was not in the expected shape",
    );
  }

  const entries: OrderPageEntry[] = [];
  for (const item of obj.data) {
    // Each listed order carries a full `address_to` — the buyer's street, and
    // on a reconcile scan it is mostly OTHER buyers' streets. Three values are
    // lifted out here and the rest of the entry is dropped on the floor, so no
    // caller can be handed an address it did not ask for and no log line can
    // acquire one by widening a field later. `metadata` is likewise not kept:
    // one string is read out of it and the object itself does not escape.
    const entry = (typeof item === "object" && item !== null ? item : {}) as {
      id?: unknown;
      external_id?: unknown;
      metadata?: unknown;
      status?: unknown;
    };
    const id =
      typeof entry.id === "string" ? entry.id : typeof entry.id === "number" ? String(entry.id) : null;
    if (id === null) continue;
    const metadata = (typeof entry.metadata === "object" && entry.metadata !== null
      ? entry.metadata
      : {}) as { shop_order_label?: unknown };
    entries.push({
      id,
      label: typeof metadata.shop_order_label === "string" ? metadata.shop_order_label : null,
      externalId: typeof entry.external_id === "string" ? entry.external_id : null,
      status: typeof entry.status === "string" ? entry.status : null,
    });
  }
  return { entries, currentPage, lastPage, total };
}

/**
 * One fetched order, reduced to the four values a status poller may keep.
 *
 * **It THROWS on a shape it cannot read rather than returning an empty one**,
 * and that is the whole point of the function. Returning `{status: null,
 * shipments: []}` for an unreadable body would hand the poller "no status and no
 * shipments" — which is exactly what a legitimately unstarted order looks like —
 * so a parse failure would be indistinguishable from real news, and it would be
 * stamped onto the row as a successful check. A page we could not understand is
 * a page we learnt nothing from.
 *
 * The captured live response carries exactly these keys per order: `id,
 * app_order_id, shop_id, address_to, line_items, metadata, total_price,
 * total_shipping, total_tax, status, shipping_method, created_at,
 * sent_to_production_at, fulfilment_type, printify_connect,
 * sales_channel_type_id`. Two of them are read. `address_to` is not one of the
 * two, and it stops here.
 *
 * `shipments` is NOT in that capture — the order it was taken from was
 * `in-production` and had not shipped — so it is treated as optional throughout:
 * absent is the normal case and never an error. That is why its absence does not
 * fail the shape check while a missing `id` does.
 */
function readOrderState(payload: unknown): PrintifyOrderState {
  const obj = (typeof payload === "object" && payload !== null ? payload : {}) as {
    id?: unknown;
    status?: unknown;
    shipments?: unknown;
  };
  const id =
    typeof obj.id === "string" ? obj.id : typeof obj.id === "number" ? String(obj.id) : null;
  if (id === null) {
    // Deliberately says nothing about what WAS there. The body is not quoted
    // back for the same reason `toPrintifyError` drops Printify's `errors`
    // object: an order body is somebody's address.
    throw new PrintifyError(502, null, "Printify order response was not in the expected shape");
  }

  const shipments: PrintifyShipment[] = [];
  if (Array.isArray(obj.shipments)) {
    for (const item of obj.shipments) {
      const s = (typeof item === "object" && item !== null ? item : {}) as {
        carrier?: unknown;
        number?: unknown;
        url?: unknown;
        delivered_at?: unknown;
      };
      shipments.push({
        carrier: typeof s.carrier === "string" ? s.carrier : null,
        number: typeof s.number === "string" ? s.number : null,
        url: typeof s.url === "string" ? s.url : null,
        deliveredAt: typeof s.delivered_at === "string" ? s.delivered_at : null,
      });
    }
  }

  return {
    id,
    status: typeof obj.status === "string" ? obj.status : null,
    shipments,
  };
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
      const payload = await printifyFetch(config, `/shops/${config.shopId}/orders.json`, "POST", {
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
      // `printifyOrderId` is passed as the fallback, so this call CANNOT raise
      // the ambiguous error: we already know the order's name, which is the
      // thing the ambiguous case is missing. Release is never ambiguous in the
      // way submission is, and re-sending an order that is already in
      // production does not manufacture a second parcel.
      const payload = await printifyFetch(
        config,
        `/shops/${config.shopId}/orders/${encodeURIComponent(printifyOrderId)}/send_to_production.json`,
        "POST",
        {},
      );
      return readOrderRef(payload, printifyOrderId);
    },

    async findOrderByExternalId(externalId: string): Promise<PrintifyOrderRef | null> {
      // Matched with `===` and never with a prefix, a case fold or a
      // "startsWith": the value is a UUID we minted, and a fuzzy match here
      // would adopt somebody else's Printify order onto this row.
      //
      // `shop_order_label` first because it is where Printify actually echoes
      // the value back, then a top-level `external_id` which no observed
      // response carries — kept so that a plan or an API version that does
      // populate it is matched rather than missed.
      for (let page = 1; page <= FIND_ORDER_MAX_PAGES; page += 1) {
        const payload = await printifyFetch(
          config,
          `/shops/${config.shopId}/orders.json?page=${page}&limit=${FIND_ORDER_PAGE_SIZE}`,
          "GET",
        );
        const { entries, lastPage } = readOrderPage(payload);
        for (const entry of entries) {
          if (entry.label === externalId || entry.externalId === externalId) {
            return { id: entry.id, status: entry.status };
          }
        }
        // The DECLARED end of the list, and only that. An empty `data` used to
        // end the scan too, which meant a page whose shape we had misread ended
        // it as well — `readOrderPage` now refuses to produce one of those, and
        // a genuinely empty shop still arrives here with `last_page = 1` and
        // gets the same answer by the honest route.
        if (page >= lastPage) return null;
      }
      throw new PrintifyError(
        502,
        null,
        "Printify order search hit its page budget without reaching the end of the list",
      );
    },

    async getOrder(printifyOrderId: string): Promise<PrintifyOrderState | null> {
      // The ONE read in this adapter that is genuinely safe to repeat: it
      // creates nothing, and the "writes are never retried" rule at the top of
      // this file is about writes. It is still not retried in a loop here —
      // the poller simply comes round again — because a provider that is
      // refusing is a provider whose error budget we are already spending.
      try {
        const payload = await printifyFetch(
          config,
          `/shops/${config.shopId}/orders/${encodeURIComponent(printifyOrderId)}.json`,
          "GET",
        );
        return readOrderState(payload);
      } catch (err) {
        // 404 is Printify ANSWERING: there is no such order in this shop. That
        // is a fact worth reporting and it is the only failure that becomes
        // `null`. Everything else — 429, 5xx, a transport failure, a body we
        // could not parse — is Printify not answering, and is rethrown so the
        // caller changes nothing about the order rather than inventing news
        // about somebody's parcel.
        if (err instanceof PrintifyError && err.status === 404) return null;
        throw err;
      }
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
