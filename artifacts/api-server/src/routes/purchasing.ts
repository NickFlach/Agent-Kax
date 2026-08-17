import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  userPaymentMethodsTable,
  userPurchasingConsentsTable,
  userShippingAddressesTable,
  usersTable,
} from "@workspace/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import { commerceEnabled, getUncachableStripeClient } from "../lib/stripeClient";
import { loadPurchasingSnapshot } from "../lib/purchasingFacts";
import {
  CURRENT_STORED_CARD_TERMS_VERSION,
  SUPPORTED_SHIP_TO_COUNTRIES,
} from "../lib/purchasingState";
import { STORED_CARD_TERMS_MARKDOWN, STORED_CARD_TERMS_SHA256 } from "../lib/storedCardTerms";
import { scrubDatabaseError } from "../lib/scrubDatabaseError";

const router: IRouter = Router();

/**
 * The purchasing settings desk: an address, a card, and a recorded agreement
 * that we may charge it.
 *
 * These endpoints only ever write the three tables migration 0026 added. They
 * take no money — the charge lives on the purchase path — and they cannot
 * reach one. Nothing here imports `lib/joinery.ts` or `lib/ledger*`, because
 * physical goods are bought with USD cents and play_credit must never be able
 * to pay for a parcel. `store_listings.price` is not read either; it is one
 * `real` column that means minor credits to the Joinery and dollars to
 * `store-checkout.ts` (#269), and the physical path is kept structurally out of
 * reach of that ambiguity rather than carefully steered around it.
 *
 * ## Card data never reaches this server
 *
 * The client confirms a SetupIntent with Stripe.js and sends back the SetupIntent
 * id. The server retrieves that SetupIntent, checks its Customer is THIS
 * account's Customer, and reads the payment method off it. A `pm_...` id from a
 * request body is never trusted and never persisted — a server that accepted
 * one would let anybody attach a stranger's card to their own account by
 * naming it, and the id is guessable-adjacent in exactly the wrong way: it is
 * shown to whoever owns the card. That is the single security hinge of this
 * file, and `POST /me/purchasing/payment-method` is written around it.
 *
 * ## Why requireAuth, and not requireWalletAuth
 *
 * `routes/auth.ts` records the rule for this repo on `PATCH /me`: wallet proof
 * gates what you may BIND to yourself, not what you may CALL yourself. Adding a
 * card looks like a binding, and the reflex is therefore to demand a signature.
 * That is refused here. Wallet proof exists to stop one account claiming
 * another's on-chain identity; a saved card is not an identity claim, it is the
 * account's own payment instrument, and it is already protected by the thing
 * that matters — Stripe only hands the payment method back through a
 * SetupIntent bound to this account's own Customer. Requiring a signature would
 * buy nothing against that and would lock every email-auth human out of
 * commerce entirely, which is most of them.
 *
 * ## The lax cookie is the CSRF protection, and it is load-bearing
 *
 * `requireAuth` carries NO CSRF token — there is no such thing anywhere in this
 * server. What stands in its place is the `sid` cookie's `SameSite=lax`
 * attribute (`auth-email.ts:74`, `auth-wallet.ts:161`, `auth-spacechild.ts:39`),
 * which keeps the browser from attaching the session to a cross-site POST,
 * PUT or DELETE. Every mutation below is one of those verbs for that reason: a
 * lax cookie IS sent on a cross-site top-level GET, so a state-changing GET
 * here would be forgeable from any page on the internet. Relaxing any of those
 * three cookies to `SameSite=none`, or adding a GET that mutates, removes the
 * only CSRF defence this surface has. That has never been written down before;
 * it is written down now.
 */

/**
 * Inert-until-configured, then fail-closed. With `KAX_COMMERCE_ENABLED` unset
 * every route below answers 404, exactly as if this router were never mounted —
 * the same gate `store-checkout.ts:17-36` uses, and for the same reason: a
 * deploy must be safe before anything is ready to sell.
 *
 * The probe checks both halves of 0026 that this file writes: the card table,
 * and the `stripe_customer_id` column on `users`. A deployment with one and not
 * the other is the realistic drift — the host's schema diff eats whole tables
 * (see `ensureCriticalSchema.ts`) while an `ALTER TABLE` that never ran leaves
 * the column missing instead — and either one alone would fail mid-flow, after
 * a Stripe Customer had already been created for an account that cannot record
 * it.
 *
 * ONLY THE POSITIVE RESULT IS CACHED. A `catch` cannot tell "migration 0026 has
 * not landed" from a connection reset, a pool timeout or a failover, and a
 * latched `false` would answer 503 for the life of the process on the strength
 * of one transient fault — fail-closed-and-stuck, cleared only by a restart
 * nobody knows to perform. Leaving the flag false re-probes on the next
 * request, so the surface comes back by itself the moment the database does. A
 * genuinely unmigrated deployment pays two `LIMIT 1` selects per request, which
 * is the correct price for a surface that is answering 503 anyway.
 */
let schemaReady = false;

/**
 * Force the next request to re-probe. Exists so a test can reach the 503
 * branch, which is otherwise unreachable once any earlier request in the same
 * process has cached a `true` — and an untested fail-closed path on the money
 * surface is one that ships unverified.
 */
export function resetPurchasingSchemaProbeForTests(): void {
  schemaReady = false;
}

router.use("/me/purchasing", async (_req, res, next) => {
  if (!commerceEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!schemaReady) {
    try {
      await db.select({ id: userPaymentMethodsTable.id }).from(userPaymentMethodsTable).limit(1);
      await db.select({ c: usersTable.stripeCustomerId }).from(usersTable).limit(1);
      schemaReady = true;
    } catch {
      res.status(503).json({ error: "Commerce enabled but schema not migrated (0026)" });
      return;
    }
  }
  next();
});

/**
 * Every mutation answers with the freshly derived purchasing state rather than
 * with the row it wrote.
 *
 * Two things fall out of that. The client never has to guess what its change
 * did to the account's eligibility — the same conclusion `GET /me` reaches,
 * reached again from the same module, so the two can never disagree. And the
 * response shape is one the address cannot fit into: `PurchasingShipsTo` is a
 * country and a postal code, so echoing back the street lines that were just
 * submitted is not something a handler here can do by accident.
 */
async function respondWithState(res: Response, userId: string): Promise<void> {
  res.json({ purchasing: await loadPurchasingSnapshot(userId) });
}

/**
 * Re-exported so this file's own test keeps reaching it here, and because a
 * reader of the address write should be able to follow the scrubber from the
 * statement it protects. The implementation moved to `lib/scrubDatabaseError.ts`
 * when `routes/commerce.ts` — the other writer of postal PII — needed it too.
 *
 * A live database failure on an address INSERT is not something a suite can
 * provoke on demand, so the guarantee is pinned against a synthetic
 * `DrizzleQueryError` of exactly the shape drizzle builds.
 */
export { scrubDatabaseError };

/**
 * Stripe answers "no such object" for an id that does not exist and for one
 * that belongs to a different Stripe account. Both are, from here, the same
 * fact: the caller named something we cannot act on.
 */
function isMissingResource(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === "resource_missing" || e.statusCode === 404;
}

/**
 * Stripe hands back an id as a bare string or, when the field was expanded, as
 * the object it points at. Both shapes mean the same thing and neither is
 * chosen by us, so every read of one goes through here rather than through a
 * `typeof` written out four times and got right three of them.
 */
function resolveId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

/**
 * A detach against a card Stripe has already let go. It is not a failure of
 * the request — the account and Stripe simply already agree — so the row still
 * gets stamped rather than the caller being told to try again forever.
 */
function isAlreadyDetached(err: unknown): boolean {
  if (isMissingResource(err)) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === "payment_method_not_attached";
}

/**
 * The Customer this account charges through, created on first use.
 *
 * The id is read from the user row before anything is sent to Stripe, so the
 * ordinary second call costs nothing. The idempotency key is what covers the
 * case the read cannot: two first-time requests in flight at once, or one whose
 * response was lost after Stripe had already created the Customer. Keyed on the
 * user id alone and never rotated, it makes "create this account's Customer" an
 * operation that can be attempted any number of times and happen exactly once.
 *
 * The persisting UPDATE is conditional on the column still being null, so a
 * request that loses the race takes the winner's id off the row instead of
 * overwriting it. Two Customers for one account would split the saved cards
 * between them, and the half attached to the forgotten Customer is
 * unreachable — the SetupIntent ownership check below would refuse the very
 * card the account just saved.
 */
async function ensureStripeCustomer(
  userId: string,
  email: string | null,
): Promise<string> {
  const [existing] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create(
    {
      // Omitted rather than sent empty: a wallet-only account has no email at
      // all, and Stripe reads "" as a malformed address rather than as absence.
      ...(email ? { email } : {}),
      metadata: { kaxUserId: userId },
    },
    { idempotencyKey: `kax-customer-${userId}` },
  );

  const [claimed] = await db
    .update(usersTable)
    .set({ stripeCustomerId: customer.id })
    .where(and(eq(usersTable.id, userId), isNull(usersTable.stripeCustomerId)))
    .returning({ stripeCustomerId: usersTable.stripeCustomerId });
  if (claimed?.stripeCustomerId) return claimed.stripeCustomerId;

  // Lost the race. Whatever the winner wrote is the account's Customer, and
  // the key above guarantees it is the same object this call just received.
  const [reread] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return reread?.stripeCustomerId ?? customer.id;
}

/**
 * The terms as served, with the digest the acceptance will be recorded under,
 * and the destinations the settings form is allowed to offer.
 *
 * The hash comes out with the document deliberately: a client that shows the
 * words can show what they hash to, and the value it is told is the value the
 * server will write. Nothing it sends back can change either.
 *
 * `supportedCountries` rides along for the same reason and at no extra round
 * trip, because the desk already has to fetch this before it can show the
 * terms. The destination list is a server fact — `AddressBody` below refuses
 * anything outside it and `derivePurchasingState` calls an address outside it
 * `unsupported_destination` — and a client that hard-coded its own copy would
 * either offer a country the PUT then rejects, or keep offering only `US` for
 * as long as it took somebody to notice that this list had grown. It is the
 * same constant both of those read, so the country a buyer can pick and the
 * country we will accept cannot drift apart.
 */
router.get("/me/purchasing/terms", requireAuth, (_req: Request, res: Response) => {
  res.json({
    version: CURRENT_STORED_CARD_TERMS_VERSION,
    sha256: STORED_CARD_TERMS_SHA256,
    markdown: STORED_CARD_TERMS_MARKDOWN,
    supportedCountries: SUPPORTED_SHIP_TO_COUNTRIES,
  });
});

/**
 * Begin saving a card: hand the browser a SetupIntent to confirm with Stripe.js.
 *
 * `usage: "off_session"` is what makes the resulting payment method reusable
 * for a later charge; without it the card would be good for exactly one
 * on-session payment and the whole settings surface would be pointless.
 */
router.post("/me/purchasing/setup-intent", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const [user] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const customerId = await ensureStripeCustomer(userId, user?.email ?? null);

  const stripe = await getUncachableStripeClient();
  // Cards only. `automatic_payment_methods` offers whatever is enabled on the
  // Stripe account — bank debits, wallets, Link — and everything downstream of
  // here is written for a card: the expiry check in `derivePurchasingState`,
  // the on-session confirm in the purchase path, and the stored-card terms the
  // buyer accepts. Offering a method that then cannot be charged is worse than
  // not offering it: the buyer saves it, sees `•••• ????` where the last four
  // digits belong, and discovers at the till that it was never going to work.
  //
  // `usage: "off_session"` still stands and is deliberate — see the design
  // note on the settings card. It is the superset, and it pushes any
  // authentication challenge to setup time, on a 2D page with a full element
  // mounted, rather than to the moment of purchase in the 3D city.
  const intent = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
  });

  // The client secret and nothing else. The Customer id is the server's
  // business, and a client that never learns it cannot be tempted to send it
  // back as an assertion about whose card this is.
  res.json({ clientSecret: intent.client_secret });
});

/**
 * A SetupIntent id, and deliberately nothing else.
 *
 * The `seti_` prefix is enforced rather than assumed. It costs one regex and it
 * makes the shape of the mistake impossible: a client that sends `pm_...` here,
 * whether by confusion or by design, is refused at the door instead of reaching
 * code that might one day treat the string as a payment method. Unknown keys
 * are dropped by zod, so a `paymentMethodId` alongside it is not an error — it
 * is simply not something this handler can read.
 */
/**
 * The one outcome inside the save transaction that is a refusal rather than a
 * failure. It exists as a class so the `catch` can tell it apart from a real
 * database error and re-throw everything else — swallowing those would turn a
 * connection fault into a cheerful 409.
 */
class PaymentMethodOwnedElsewhere extends Error {}

const SaveCardBody = z.object({
  setupIntentId: z.string().regex(/^seti_[A-Za-z0-9_]+$/, "setupIntentId must be a Stripe SetupIntent id"),
});

/**
 * Finish saving a card.
 *
 * The order of the checks is the security property. The SetupIntent is fetched
 * FROM STRIPE by id; its Customer is compared against the one on this user's
 * row; only then is the payment method read off it. A caller who names a
 * SetupIntent belonging to somebody else's Customer is refused before anything
 * is written, so the refusal costs them nothing and tells them nothing.
 *
 * An account with no Customer yet is refused by the same comparison rather than
 * by a separate branch, because the separate branch is where the bug lives: a
 * null customer id on our side matching a null customer on a SetupIntent would
 * be "equal", and would attach an unowned card to whoever asked first.
 */
router.post("/me/purchasing/payment-method", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const parsed = SaveCardBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  const [user] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const ownCustomerId = user?.stripeCustomerId ?? null;

  const stripe = await getUncachableStripeClient();
  const intent = await stripe.setupIntents
    .retrieve(parsed.data.setupIntentId)
    .catch((err: unknown) => {
      if (isMissingResource(err)) return null;
      throw err;
    });

  const intentCustomerId = resolveId(intent?.customer);

  // One refusal for every way this can fail to be the caller's card: no
  // Customer on the account, an unknown SetupIntent, a customerless one, or one
  // belonging to somebody else. They are the same answer on purpose — a
  // distinguishable "that intent exists but is not yours" would confirm the id
  // to whoever guessed it.
  if (
    intent === null ||
    ownCustomerId === null ||
    intentCustomerId === null ||
    intentCustomerId !== ownCustomerId
  ) {
    res.status(403).json({ error: "That setup intent does not belong to this account" });
    return;
  }

  const paymentMethodId = resolveId(intent.payment_method);
  if (paymentMethodId === null) {
    res.status(409).json({ error: "That setup intent has not been confirmed with a card yet" });
    return;
  }

  const method = await stripe.paymentMethods.retrieve(paymentMethodId);

  // Cards only, and refused here rather than trusted from the element.
  //
  // The SetupIntent now asks Stripe for `payment_method_types: ["card"]`, so
  // the element should never offer anything else — but which methods a buyer
  // is shown is account configuration and a client-side widget, and neither is
  // a permission. Without this check a bank debit or a wallet saves a row with
  // no `card` object at all: `brand` and `last4` land NULL, the dashboard
  // renders the placeholder `•••• ????`, and the purchase then tries to
  // confirm a mandate-based method on-session as though it were a card and
  // fails with a 500 the buyer cannot act on.
  //
  // This is not a statement that only cards are worth supporting. It is that
  // everything downstream — the expiry check in `derivePurchasingState`, the
  // on-session confirm in the purchase path, the saved-card terms the buyer
  // agreed to — is written for a card today. A bank debit settles over days,
  // which the charge-then-submit-to-Printify ordering assumes away. Adding one
  // means changing those, not relaxing this.
  if (method.type !== "card" || !method.card) {
    res.status(400).json({
      error: "Only a card can be saved for physical purchases at the moment",
      code: "unsupported_payment_method",
      paymentMethodType: method.type,
    });
    return;
  }
  const card = method.card;

  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      // The newly saved card becomes the default, so the previous one stops
      // being it. Two default rows would make `selectCard()` in
      // purchasingState.ts pick by insertion order, which is to say
      // arbitrarily — the panel would name one card and a charge would use the
      // other.
      await tx
        .update(userPaymentMethodsTable)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(userPaymentMethodsTable.userId, userId),
            eq(userPaymentMethodsTable.isDefault, true),
          ),
        );

      const written = await tx
        .insert(userPaymentMethodsTable)
        .values({
          userId,
          stripePaymentMethodId: paymentMethodId,
          brand: card?.brand ?? null,
          last4: card?.last4 ?? null,
          expMonth: card?.exp_month ?? null,
          expYear: card?.exp_year ?? null,
          isDefault: true,
        })
        .onConflictDoUpdate({
          // Re-saving a card that was removed earlier revives the existing row
          // rather than colliding with it — `stripe_payment_method_id` is
          // unique across the whole table, not per user.
          target: userPaymentMethodsTable.stripePaymentMethodId,
          set: {
            brand: card?.brand ?? null,
            last4: card?.last4 ?? null,
            expMonth: card?.exp_month ?? null,
            expYear: card?.exp_year ?? null,
            isDefault: true,
            detachedAt: null,
            updatedAt: now,
          },
          // Postgres resolves an unqualified column in this clause against the
          // EXISTING row, so this reads "only if that row is already mine". A
          // payment method cannot change hands by being saved again.
          setWhere: eq(userPaymentMethodsTable.userId, userId),
        })
        .returning({ id: userPaymentMethodsTable.id });

      // Nothing written means the conflicting row belongs to someone else.
      // Thrown rather than returned so the default-clearing UPDATE above rolls
      // back with it: a refusal must leave the account exactly as it found it,
      // and committing half of this would strip the buyer's working default
      // card as the price of a request that was denied.
      if (written.length === 0) throw new PaymentMethodOwnedElsewhere();
    });
  } catch (err) {
    // Same leak, different secret: a failed statement here would put the
    // payment-method id into a log line through drizzle's own message.
    if (!(err instanceof PaymentMethodOwnedElsewhere)) throw scrubDatabaseError("card write", err);
    res.status(409).json({ error: "That payment method is already saved to another account" });
    return;
  }

  await respondWithState(res, userId);
});

/**
 * Where a parcel may be sent.
 *
 * `country` is validated against the same list the derived state judges an
 * account by, so "we accepted your address and then told you we cannot ship to
 * it" is not a reachable sequence. The refusal is field-level because the form
 * has eight fields and "invalid address" tells the buyer to re-check all of
 * them.
 *
 * Lengths are bounded on every field. These strings end up in a Printify
 * submission and on a shipping label, and an unbounded one is a way to make a
 * row that cannot be fulfilled after the card has already been charged.
 */
/**
 * One trimmed, bounded, control-character-free address field.
 *
 * The control-character check follows `PATCH /me` in `auth.ts`, which refuses
 * them in a display name for the same reason and states it plainly: a control
 * character is how a value breaks out of the line it was supposed to occupy.
 * Here the lines it would break out of are a printed shipping label and the
 * JSON body of a fulfilment submission. A NUL in particular is not storable at
 * all — Postgres rejects it as an invalid UTF-8 byte sequence — so without this
 * it would surface as a failed write on an address that had already been
 * accepted, which is the worst place to discover it.
 */
function addressField(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/, "must not contain control characters");
}

const AddressBody = z.object({
  name: addressField(120).min(1, "Required"),
  line1: addressField(200).min(1, "Required"),
  // Nullish, not merely optional: a form with an empty second line sends null
  // about as often as it omits the key, and refusing one of those two spellings
  // would be a validation error about nothing.
  line2: addressField(200).nullish(),
  city: addressField(120).min(1, "Required"),
  region: addressField(120).min(1, "Required"),
  postalCode: addressField(32).min(1, "Required"),
  country: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => SUPPORTED_SHIP_TO_COUNTRIES.includes(v), {
      message: `We can only ship to ${SUPPORTED_SHIP_TO_COUNTRIES.join(", ")} for now`,
    }),
  phone: addressField(40).nullish(),
  /**
   * Whether the form that submitted this address had a validator say it was
   * complete — for the settings desk, Stripe's Address Element reporting
   * `complete: true` on its own change event.
   *
   * The BOOLEAN comes from the client; the NAME of the method does not, in the
   * same way and for the same reason that `POST /consent` takes a version
   * string and writes the server's own document hash. A client can only say
   * "something checked this", never "this was checked by X" — otherwise the
   * column would record whatever a request cared to claim, and
   * `validation_method` exists precisely so that a later verification pass can
   * tell one kind of check from another.
   *
   * Optional and defaulted to false, because absence is the honest answer. An
   * address typed into a form with no validator behind it, or submitted by a
   * client written before this field existed, is exactly what a null
   * `validated_at` means: "the buyer typed it and nobody has confirmed it".
   * Defaulting to true would make the column say the opposite about the same
   * request.
   */
  validated: z.boolean().optional(),
});

/**
 * What stamped `validation_method` when the settings desk says an address was
 * checked. A constant here rather than a string from the request: see the
 * `validated` field on `AddressBody`.
 */
const ADDRESS_VALIDATION_METHOD = "stripe_address_element";

/**
 * An optional line that arrived empty is stored as absent. "" and null mean the
 * same thing to a courier, and only one of them keeps the column honest about
 * whether a second line exists.
 */
function optionalLine(value: string | null | undefined): string | null {
  return value ? value : null;
}

/**
 * Save the shipping address.
 *
 * The prior row is ARCHIVED and a new one inserted; nothing is updated in
 * place. An order snapshots the address it shipped to, but the archived row is
 * what keeps the earlier value readable at all — editing in place would rewrite
 * the buyer's own history of where they had asked things to be sent, and take
 * the evidence for a "that is not where I live" dispute with it. The partial
 * unique index (`archived_at IS NULL`) is what keeps exactly one of them live,
 * so both statements have to be one transaction or the insert races the index.
 *
 * Nothing in this handler logs, echoes, or returns any field it was given.
 * `user_shipping_addresses` is the first postal PII in this schema and the
 * response is the derived state, which has room for a country and a postal code
 * and nothing else.
 */
router.put("/me/purchasing/address", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const parsed = AddressBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    // Paths and messages only. Zod's messages describe the constraint, never
    // the submitted value, which is what keeps a rejected address out of a
    // response body that may well end up in a client-side error log.
    res.status(400).json({
      error: "Invalid address",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const address = parsed.data;

  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(userShippingAddressesTable)
        .set({ archivedAt: now, updatedAt: now })
        .where(
          and(
            eq(userShippingAddressesTable.userId, userId),
            isNull(userShippingAddressesTable.archivedAt),
          ),
        );
      await tx.insert(userShippingAddressesTable).values({
        userId,
        name: address.name,
        line1: address.line1,
        line2: optionalLine(address.line2),
        city: address.city,
        region: address.region,
        postalCode: address.postalCode,
        country: address.country,
        phone: optionalLine(address.phone),
        // Both columns move together or neither does. A `validated_at` with no
        // `validation_method` records that something checked the address
        // without recording what, which is not a fact anyone can act on later;
        // a method with no timestamp is worse, because it reads as validated
        // to a query that only tests the method column.
        validatedAt: address.validated ? now : null,
        validationMethod: address.validated ? ADDRESS_VALIDATION_METHOD : null,
      });
    });
  } catch (err) {
    // The one place in this server where a raw database error carries a home
    // address. See `scrubDatabaseError`.
    throw scrubDatabaseError("shipping address write", err);
  }

  await respondWithState(res, userId);
});

const ConsentBody = z.object({ termsVersion: z.string().min(1) });

/**
 * Record that the buyer accepted the stored-card terms.
 *
 * The client says WHICH version it displayed; the server decides what that
 * version says. `terms_sha256` is the digest of the document this server
 * serves, computed in `storedCardTerms.ts` and never taken from the request —
 * a hash a client could choose is a hash that proves nothing, and the column
 * exists precisely because a version string alone records the name of a file
 * rather than its contents.
 *
 * A stale `termsVersion` is refused rather than quietly upgraded. The client
 * showed the buyer some other document, and consent to a document nobody
 * displayed is not consent.
 */
router.post("/me/purchasing/consent", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const parsed = ConsentBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (parsed.data.termsVersion !== CURRENT_STORED_CARD_TERMS_VERSION) {
    res.status(409).json({
      error: "Those are not the current stored-card terms",
      currentVersion: CURRENT_STORED_CARD_TERMS_VERSION,
    });
    return;
  }

  try {
    await db.insert(userPurchasingConsentsTable).values({
      userId,
      // The server's constant, not the request's string, even though the check
      // above proves them equal. What is written is what was served.
      termsVersion: CURRENT_STORED_CARD_TERMS_VERSION,
      termsSha256: STORED_CARD_TERMS_SHA256,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
  } catch (err) {
    // The bound parameters here are the buyer's IP address and user agent.
    throw scrubDatabaseError("consent write", err);
  }

  await respondWithState(res, userId);
});

/**
 * Remove the saved card.
 *
 * The row is found by user id first, so the only card this endpoint can ever
 * detach is one already on the caller's own account — the id is never taken
 * from the request, which is the same rule that governs saving one.
 *
 * Stripe is asked first and the row is stamped after. A card Stripe has already
 * let go still gets stamped: the point of `detached_at` is that the account and
 * Stripe agree about what is chargeable, and refusing to record a detachment
 * that has already happened would leave the row claiming a card that is gone.
 */
router.delete("/me/purchasing/payment-method", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const [row] = await db
    .select({
      id: userPaymentMethodsTable.id,
      stripePaymentMethodId: userPaymentMethodsTable.stripePaymentMethodId,
    })
    .from(userPaymentMethodsTable)
    .where(
      and(eq(userPaymentMethodsTable.userId, userId), isNull(userPaymentMethodsTable.detachedAt)),
    )
    // The same precedence `selectCard()` uses in purchasingState.ts: the
    // default card, else the newest. Removing "your card" has to remove the one
    // the panel was calling your card.
    .orderBy(desc(userPaymentMethodsTable.isDefault), desc(userPaymentMethodsTable.createdAt))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "No saved card to remove" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  try {
    await stripe.paymentMethods.detach(row.stripePaymentMethodId);
  } catch (err) {
    if (!isAlreadyDetached(err)) throw err;
  }

  await db
    .update(userPaymentMethodsTable)
    .set({ detachedAt: new Date(), isDefault: false, updatedAt: new Date() })
    .where(and(eq(userPaymentMethodsTable.id, row.id), isNull(userPaymentMethodsTable.detachedAt)));

  await respondWithState(res, userId);
});

export default router;
