/**
 * The purchase panel: one price, one press, one charge.
 *
 * This is the ONLY thing in the application that buys a physical good. It is
 * mounted from the 2D artifact page (`pages/agent-storefront-artifact.tsx`) and
 * from the in-city checkout desk (`pages/store-interior.tsx`, #288), and those
 * are two entry points to one component rather than two flows. The reason is
 * not tidiness: the quote / retry / poll / idempotency protocol below is the
 * only thing standing between a lost response and a card charged twice, and a
 * second implementation of it is a second chance to get that wrong in a way
 * nobody notices until a buyer complains.
 *
 * ## Plain DOM, deliberately
 *
 * Nothing here imports `three`, `@react-three/fiber` or drei, so the desk can
 * render it OUTSIDE its `<Canvas>` as a sibling to the overlay. A panel built
 * out of drei `<Text>` could not be read by a screen reader, could not be
 * tabbed into, and could not be mounted on a 2D page at all.
 *
 * ## Why the 2D page is the accessible path
 *
 * `pages/marketplace-3d.tsx` carries an sr-only skip link and a full storefront
 * `<nav>` precisely because a 3D room is not keyboard-navigable. Everything
 * below is a `<button>`, an `<a>` or a live region, in document order, so the
 * whole purchase runs on Tab and Enter. The desk in the room is the scenic
 * route; this is the one that has to work.
 *
 * ## No Elements, and normally no Stripe iframe
 *
 * `<Elements>` mounts in exactly one component in the whole application —
 * `components/physical-purchasing-card.tsx`, the settings desk — and this file
 * does not import `@stripe/react-stripe-js` at all. The only Stripe call here
 * is `handleNextAction({ clientSecret })`, which takes a client secret and no
 * Elements instance, and it is reached only when a bank actually demands a
 * challenge. `getStripe()` is therefore called at that moment rather than on
 * mount, so under normal conditions Stripe.js is never even fetched into the
 * game view.
 *
 * ## The card is never ours to touch
 *
 * There is no card in this component. The server charges the payment method
 * already attached to the account's Stripe Customer; nothing about it crosses
 * this boundary but a brand and four digits, and those come from `GET /me`.
 *
 * ## The shipping address is never rendered and never logged
 *
 * `POST /commerce/purchase` snapshots it onto the order server-side and no
 * endpoint on this path returns it. There is no address in scope here, which is
 * the strongest form of "never put it in an error toast".
 *
 * ## The state badge is a hint, not a permission
 *
 * `purchasing` comes from `GET /me` and is seconds old by the time Buy is
 * pressed. The server recomputes on every quote and every purchase and refuses
 * with the same twelve state codes, so a panel that looks ready over an account
 * that is not simply gets an honest refusal. Nothing here decides eligibility.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { appUrl } from "@/lib/urls";
import { getStripe } from "@/lib/stripe";
import { purchasingCopy } from "@/lib/purchasing";
import {
  CommerceError,
  ORDER_POLL_INTERVAL_MS,
  ORDER_POLL_TIMEOUT_MS,
  fetchOrder,
  fetchQuote,
  formatMoney,
  isSuccessfulOutcome,
  newClientReference,
  refusalAdvice,
  shouldReuseReference,
  stepFor,
  submitPurchase,
  type CommerceQuote,
  type PhysicalProduct,
  type RefusalAdvice,
} from "@/lib/commerce";

/** Where a buyer goes to add an address, a card, or an acceptance. */
const SETTINGS_HREF = "/dashboard#physical-purchasing";

export interface PurchasePanelProps {
  /** The product on offer, from `GET /commerce/products/for-artifact/:id`. */
  product: PhysicalProduct;
  /**
   * Where sign-in should come back to. The desk passes its own `?at=desk` URL
   * so a buyer who signed in mid-room returns to the desk rather than the door;
   * the 2D page lets this default to wherever it is mounted.
   */
  signInReturnTo?: string;
  /**
   * Called whenever the panel is waiting on the network — which covers the
   * whole charge, from the purchase POST through any bank challenge to the last
   * poll, and also the much shorter quote fetch.
   *
   * The seam the in-city desk uses to suspend its first-person rig: typing into
   * a 3DS challenge must not walk the avatar across the room. Deliberately a
   * superset of "a charge is in flight" rather than exactly it — holding still
   * for an extra half second while a price loads costs nothing, and a rig that
   * resumed between two steps of one purchase would be the bug.
   */
  onBusyChange?: (busy: boolean) => void;
  /** Rendered as a Close button and bound to Escape when provided. */
  onClose?: () => void;
  /**
   * Open the settings and orders links in a new tab instead of navigating.
   *
   * The in-city desk sets this, and it is the mechanism behind that surface's
   * rule that the player never leaves `/s/:slug/room`. A same-tab hop to the
   * dashboard would unmount the whole 3D room, drop the quote and the
   * reference with it, and land the buyer back at the glass door on the way
   * home. It is also what makes the `visibilitychange` re-check above mean
   * anything: the buyer fixes their card in the other tab and comes BACK to a
   * panel that is still open, still where they left it, and now buyable.
   *
   * Off by default, because on the 2D article page these are ordinary
   * in-document links and a page that spawns tabs unasked is the rude one.
   *
   * Sign-in is deliberately NOT covered. It is a same-tab navigation that
   * carries `returnTo`, and the room answers that with `?at=desk` so the buyer
   * walks back in at the counter — a session cookie set in a detached tab is a
   * worse experience than a round trip that comes home to the right spot.
   */
  newTab?: boolean;
  className?: string;
}

/**
 * The `target`/`rel` pair for a link that leaves this panel.
 *
 * `rel` is not optional beside `target="_blank"`: without `noopener` the opened
 * tab gets a live `window.opener` handle back into the room.
 */
function linkTargetProps(newTab: boolean | undefined) {
  return newTab ? ({ target: "_blank", rel: "noopener noreferrer" } as const) : {};
}

export function PurchasePanel({
  product,
  signInReturnTo,
  onBusyChange,
  onClose,
  newTab,
  className,
}: PurchasePanelProps) {
  const { user, purchasing, isLoading, refresh } = useAuth();

  const [quote, setQuote] = useState<CommerceQuote | null>(null);
  const [busy, setBusy] = useState(false);
  /** The live region's sentence: what is happening right now. */
  const [progress, setProgress] = useState<string | null>(null);
  const [failure, setFailure] = useState<RefusalAdvice | null>(null);
  const [settled, setSettled] = useState<{ orderRef: string; outcome: string } | null>(null);

  /**
   * The idempotency key for the purchase currently being attempted.
   *
   * A ref and not state, because it must not be a render away from correct: the
   * retry that reuses it can be fired from a click handler that closed over a
   * stale render. It is minted on the first press and CLEARED only when the
   * server has given a verdict — see `shouldReuseReference`.
   */
  const reference = useRef<string | null>(null);

  /** False after unmount, so a poll in flight cannot set state into nothing. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * The busy callback, fired on a CHANGE of busy rather than on every render.
   *
   * The desk passes an inline lambda that flips its rig's `suspended` prop, and
   * a plain `[busy, onBusyChange]` dependency list would re-run this on every
   * parent render — which, for a page that re-renders on a 3D frame, is every
   * frame.
   */
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    onBusyChangeRef.current?.(busy);
  }, [busy]);
  /**
   * Unmounting releases the suspension, whatever `busy` was at the time.
   *
   * `buy()`'s `finally` is guarded by `if (alive.current)`, so a panel that
   * disappears mid-charge never reports `busy = false` — and the desk drives
   * its first-person rig's `suspended` prop off exactly that callback. The
   * result is a player who cannot walk, cannot look-drag and cannot reopen the
   * panel (`if (paymentBusy || playing) return;`) until they reload, with
   * nothing on screen to explain it, because the shield is gated on the same
   * `panelOpen` that just went false.
   *
   * The unmount is reachable: the desk renders this under `deskProduct &&
   * panelOpen`, and `deskProduct` comes from a query that refetches when the
   * tab regains focus — which is what returning from a 3D Secure challenge or
   * from the settings tab does.
   *
   * Its OWN mount-scoped effect rather than a cleanup on the `[busy]` effect
   * above: that cleanup runs on every transition, so it would emit a false
   * immediately before each true and the rig would unsuspend for a frame in
   * the middle of a live charge.
   */
  useEffect(
    () => () => {
      onBusyChangeRef.current?.(false);
    },
    [],
  );

  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Only when the panel is a thing that opened over something else. Stealing
    // focus on a page where the panel is simply part of the article would move
    // a reader who was in the middle of the description.
    if (onClose) panelRef.current?.focus();
  }, [onClose]);

  const state = purchasing?.state ?? null;
  const live = !!user && !!state && state !== "disabled" && state !== "anonymous";
  const buyable = state === "ready" || state === "card_expiring";

  /**
   * Re-read the account's purchasing state when the tab comes back.
   *
   * The buyer leaves for `/dashboard#physical-purchasing`, adds a card, and
   * returns — in the room, without navigating at all. Without this the panel
   * would still be showing the blocked state it was rendered with and the Buy
   * button would still be missing, and the only way out would be a reload the
   * desk is specifically designed not to need.
   */
  useEffect(() => {
    if (!user) return;
    const recheck = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    // `visibilitychange` is fired at the document; `focus` at the window. Both,
    // because a tab switch on the same window fires only the first and an
    // alt-tab back to an already-visible tab fires only the second.
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [user, refresh]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      // Never while money is moving. A stray Escape during a 3DS challenge
      // would unmount the panel that is waiting for its result.
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  /**
   * Ask for a price.
   *
   * Quotes stand for five minutes and the server refuses a stale one rather
   * than charging it, so this is called on entering a buyable state and again
   * whenever a refusal says the price has moved.
   */
  const getQuote = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const fresh = await fetchQuote(product.sku);
      if (!alive.current) return;
      setQuote(fresh);
    } catch (err) {
      if (!alive.current) return;
      setFailure(refusalAdvice(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [product.sku]);

  useEffect(() => {
    // One automatic quote, when the account first looks buyable and there is
    // nothing on screen yet. Not re-run on every render of a buyable state,
    // which would re-price under the buyer between reading and pressing.
    // `quote` and `settled` are read as guards rather than listed as
    // dependencies on purpose: listing them would re-fire this the moment a
    // quote arrives and re-price the item under a buyer mid-read.
    if (!buyable || quote || settled) return;
    void getQuote();
  }, [buyable, getQuote]);

  /**
   * Watch an order until the server says what happened to it.
   *
   * The poll is what covers both the charge that is still settling and the
   * charge whose response never arrived. It gives up after a minute and points
   * at `/orders` rather than declaring anything: the webhook settles the order
   * whether or not this tab is open, so a timeout here is a fact about the tab
   * and not about the money.
   */
  const pollUntilSettled = useCallback(async (orderRef: string) => {
    const deadline = Date.now() + ORDER_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_POLL_INTERVAL_MS));
      if (!alive.current) return null;
      try {
        const order = await fetchOrder(orderRef);
        if (stepFor(order.status) === "settled") return order.status;
      } catch {
        // A failed poll is not a failed purchase. Keep asking until the
        // deadline; the order exists either way.
      }
    }
    return null;
  }, []);

  /**
   * Buy.
   *
   * Every exit from this function either records a verdict or leaves the
   * reference in place for a retry, and which of those happens is decided by
   * `shouldReuseReference` rather than by the shape of the catch block.
   */
  async function buy() {
    if (!quote || busy) return;
    setBusy(true);
    setFailure(null);
    setProgress("Charging your card…");

    // Minted once and reused across every retry of THIS purchase. The server
    // writes the order row under it before it calls Stripe and derives the
    // Stripe idempotency key from it, so a second send finds the first send's
    // charge instead of making another.
    reference.current ??= newClientReference();
    const orderRef = reference.current;

    /**
     * True when the bank challenge itself reported an error — which is what a
     * buyer who closes or cancels the 3DS modal produces.
     *
     * Kept rather than discarded, because it is the one signal the client holds
     * that a poll timing out is unlikely to be "still settling". The order stays
     * at `authenticating` and no webhook will ever move it, so the poll runs its
     * full minute and returns null — and without this flag that lands in exactly
     * the same place as a genuinely slow charge: "Order placed".
     */
    let challengeErrored = false;

    try {
      let result = await submitPurchase(quote.quoteId, orderRef);

      if (stepFor(result.status) === "authenticate") {
        if (!result.clientSecret) throw new CommerceError("Your bank asked for a confirmation we could not start.");
        setProgress("Your bank needs to confirm this payment…");
        const stripe = await loadStripeForChallenge();
        // The one Stripe call on this path. A client secret and nothing else —
        // no Elements instance, and therefore no card fields anywhere near it.
        const { error } = await stripe.handleNextAction({ clientSecret: result.clientSecret });
        if (error) {
          // The challenge was refused or abandoned. The order exists and the
          // server is the authority on what became of it, so ask rather than
          // conclude — the buyer may yet have completed the challenge in a
          // second window, and only the server can see that.
          challengeErrored = true;
          setProgress("Checking what happened…");
        }
        // Whatever the challenge did, the outcome is the server's to report.
        result = { ...result, status: "processing" };
      }

      let outcome = result.status;
      let polledOut = false;
      if (stepFor(outcome) === "poll") {
        setProgress("Confirming your order…");
        const settledStatus = await pollUntilSettled(orderRef);
        polledOut = settledStatus === null;
        outcome = settledStatus ?? "processing";
      }

      if (!alive.current) return;

      // An abandoned challenge that then told us nothing. Reported as the
      // unfinished confirmation it is rather than as an order placed: a buyer
      // who cancelled their own payment must not be shown a receipt, and their
      // next move is the same Buy button, not the order list.
      if (challengeErrored && polledOut) {
        setProgress(null);
        reference.current = null;
        setFailure({
          message:
            "That confirmation wasn’t completed and nothing was charged yet. You can try the purchase again.",
          recourse: "retry",
        });
        return;
      }

      setProgress(null);

      // The reference is spent either way. An order exists under it and the
      // server has either judged it or is still settling it; a second press
      // that reused this key would report THIS order forever rather than
      // buying anything.
      reference.current = null;

      if (outcome === "failed" || outcome === "canceled") {
        // A settled non-payment. Not "order placed": nothing was charged, and
        // the buyer's next move is their card rather than the order list.
        setFailure({
          message:
            outcome === "failed"
              ? "The payment did not go through and nothing was charged. Check your card and try again."
              : "That purchase was canceled and nothing was charged.",
          recourse: outcome === "failed" ? "settings" : "none",
        });
        return;
      }

      // `paid`, `refunded`, `chargeback`, or a poll that ran out of time. All
      // four are orders that exist, and `/orders` is where they are settled.
      setSettled({ orderRef, outcome });
    } catch (err) {
      if (!alive.current) return;
      const advice = refusalAdvice(err);
      // A refusal the server actually made is a decision about THIS reference,
      // and every retry under it would get the same answer. An unanswered send
      // is the opposite: the charge may exist, so the key survives.
      if (!shouldReuseReference(err)) reference.current = null;
      if (advice.recourse === "requote") setQuote(null);
      setFailure(advice);
      setProgress(null);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const heading = product.title;
  const price = formatMoney(quote?.totalCents ?? product.totalCents, quote?.currency ?? product.currency);
  // Generated rather than a literal: an artifact with two published products
  // mounts two panels on one page, and two elements with the same id make the
  // second heading label the first panel.
  const headingId = useId();

  return (
    <section
      ref={panelRef}
      tabIndex={onClose ? -1 : undefined}
      aria-labelledby={headingId}
      className={cn("border border-border bg-background p-4 space-y-3 text-left", className)}
      data-testid="purchase-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 id={headingId} className="text-xs uppercase tracking-widest text-muted-foreground">
          {heading}
        </h3>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy} data-testid="button-close-purchase">
            Close
          </Button>
        )}
      </div>

      <p className="text-2xl font-bold" data-testid="text-purchase-total">
        {price}
      </p>

      {/* The lines the server quoted, item and shipping apart, so the total is
          never a number the buyer has to take on trust. */}
      {quote && (
        <ul className="text-xs text-muted-foreground space-y-1" data-testid="list-quote-lines">
          {quote.lines.map((line) => (
            <li key={`${line.kind}-${line.label}`} className="flex justify-between gap-4">
              <span>{line.label}</span>
              <span className="font-mono">{formatMoney(line.amountCents, quote.currency)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Everything a screen reader has to be told as it happens goes through
          one polite live region, so a buyer who cannot see the button change
          still hears "charging", "confirming", "done". */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="text-purchase-progress">
        {progress ?? ""}
      </p>

      {settled ? (
        <SettledNotice orderRef={settled.orderRef} outcome={settled.outcome} newTab={newTab} />
      ) : isLoading ? (
        <p className="text-xs text-muted-foreground">Checking your account…</p>
      ) : !user ? (
        <SignInPrompt returnTo={signInReturnTo} />
      ) : !live ? (
        // The server said `disabled` (the surface is off) or has not answered
        // yet. Either way there is nothing to offer and nothing to fix.
        <p className="text-xs text-muted-foreground" data-testid="text-purchase-unavailable">
          Physical purchasing isn&rsquo;t available right now.
        </p>
      ) : !buyable ? (
        <BlockedNotice state={state!} newTab={newTab} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={buy}
            disabled={busy || !quote}
            className="uppercase tracking-widest"
            data-testid="button-buy-physical"
          >
            {busy ? "Working…" : quote ? `Buy — ${price}` : "Getting price…"}
          </Button>
          {state === "card_expiring" && (
            <a
              href={appUrl(SETTINGS_HREF)}
              {...linkTargetProps(newTab)}
              className="text-[11px] uppercase tracking-widest text-primary underline"
              data-testid="link-purchasing-settings-advisory"
            >
              Card expires soon
            </a>
          )}
        </div>
      )}

      {failure && (
        <div className="space-y-2 border-t border-border pt-3" role="alert" data-testid="text-purchase-error">
          <p className="text-xs text-destructive">{failure.message}</p>
          <FailureAction advice={failure} busy={busy} newTab={newTab} onRequote={getQuote} onRetry={buy} />
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Charged in real money to the card in your purchasing settings. Nothing on this panel spends
        credits.
      </p>
    </section>
  );
}

/**
 * Stripe.js, fetched at the moment a bank challenge demands it.
 *
 * Not on mount, and not from the settings card's provider. The desk mounts this
 * panel inside a 3D room, and fetching Stripe.js up front would put a Stripe
 * frame in a view that is supposed to have none — the whole reason the loader
 * lives in `lib/stripe.ts` apart from every card-entry component.
 */
async function loadStripeForChallenge() {
  const promise = getStripe();
  if (!promise) {
    throw new CommerceError(
      "This build has no Stripe publishable key, so a bank confirmation cannot be completed.",
    );
  }
  const stripe = await promise;
  if (!stripe) throw new CommerceError("Stripe could not be loaded to confirm this payment.");
  return stripe;
}

/**
 * Sign-in, carrying where to come back to.
 *
 * `/s/:slug` and `/s/:slug/room` are both public routes, so most first-time
 * buyers meet this panel signed out. An anchor and not a button: it is a
 * navigation, it works with a middle click, and it needs no JavaScript to be
 * reachable from the keyboard.
 */
function SignInPrompt({ returnTo }: { returnTo?: string }) {
  const target = returnTo ?? `${window.location.pathname}${window.location.search}`;
  return (
    <a
      href={appUrl(`/login?returnTo=${encodeURIComponent(target)}`)}
      className="inline-block border border-primary bg-primary text-primary-foreground px-4 py-2 text-xs font-bold uppercase tracking-widest"
      data-testid="link-sign-in-to-buy"
    >
      Sign in to buy
    </a>
  );
}

/**
 * A blocked account, in the server's own words.
 *
 * The sentence is `PURCHASING_STATE_COPY`'s, which is generated from the same
 * twelve states the server derives — so the desk, the settings card and this
 * panel all say the same thing about the same account rather than three
 * paraphrases of it.
 */
function BlockedNotice({ state, newTab }: { state: string; newTab?: boolean }) {
  const copy = purchasingCopy(state);
  return (
    <div className="space-y-2" data-testid="text-purchase-blocked">
      <p className="text-xs text-muted-foreground">{copy.detail}</p>
      {/* `cap_reached` clears with the clock and `unsupported_destination`
          cannot be cleared here at all, so neither gets a link that promises a
          fix. Everything else is a thing the settings card can put right. */}
      {state !== "cap_reached" && (
        <a
          href={appUrl(SETTINGS_HREF)}
          {...linkTargetProps(newTab)}
          className="inline-block border border-primary px-3 py-2 text-[11px] uppercase tracking-widest text-primary"
          data-testid="link-purchasing-settings"
        >
          Open purchasing settings
        </a>
      )}
    </div>
  );
}

/**
 * What happened, once the server has said.
 *
 * `processing` is reported as an order placed rather than as a failure, because
 * that is what it is: the row exists, the webhook will settle it, and the buyer
 * needs the reference and somewhere to look — not a Buy button that would make
 * a second one.
 */
function SettledNotice({
  orderRef,
  outcome,
  newTab,
}: {
  orderRef: string;
  outcome: string;
  newTab?: boolean;
}) {
  const paid = isSuccessfulOutcome(outcome);
  return (
    <div className="space-y-2" data-testid="text-purchase-settled">
      <p className={cn("text-sm font-bold", paid ? "text-primary" : "text-muted-foreground")}>
        {paid ? "Order placed" : "Order placed — still confirming"}
      </p>
      <p className="text-[11px] font-mono text-muted-foreground" data-testid="text-order-ref">
        {orderRef}
      </p>
      <a
        href={appUrl("/orders")}
        {...linkTargetProps(newTab)}
        className="inline-block border border-primary px-3 py-2 text-[11px] uppercase tracking-widest text-primary"
        data-testid="link-my-orders"
      >
        View your orders
      </a>
    </div>
  );
}

/** The one button a refusal earns, chosen by what would actually help. */
function FailureAction({
  advice,
  busy,
  newTab,
  onRequote,
  onRetry,
}: {
  advice: RefusalAdvice;
  busy: boolean;
  newTab?: boolean;
  onRequote: () => void;
  onRetry: () => void;
}) {
  if (advice.recourse === "settings") {
    return (
      <a
        href={appUrl(SETTINGS_HREF)}
        {...linkTargetProps(newTab)}
        className="inline-block border border-primary px-3 py-2 text-[11px] uppercase tracking-widest text-primary"
        data-testid="link-purchasing-settings-fix"
      >
        Open purchasing settings
      </a>
    );
  }
  if (advice.recourse === "requote") {
    return (
      <Button size="sm" onClick={onRequote} disabled={busy} data-testid="button-requote">
        Get the current price
      </Button>
    );
  }
  if (advice.recourse === "retry") {
    return (
      <Button size="sm" onClick={onRetry} disabled={busy} data-testid="button-retry-purchase">
        Try again
      </Button>
    );
  }
  return null;
}
