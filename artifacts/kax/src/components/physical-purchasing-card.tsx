/**
 * The physical purchasing desk: an address, a card, and a recorded agreement
 * that we may charge it.
 *
 * ## This is the only place `<Elements>` mounts in the whole application
 *
 * Card data never touches a KAX server and never touches KAX state. The number,
 * the expiry and the CVC are typed into an iframe served by Stripe from
 * `js.stripe.com`; this component never sees them, never holds them, and has no
 * field they could be assigned to. What crosses our wire afterwards is a
 * SetupIntent id — `seti_...` — which the server exchanges for the card's
 * display metadata by asking Stripe directly, after checking the intent belongs
 * to this account's Customer. A `pm_...` from a request body is refused there,
 * so it is never sent from here.
 *
 * The 3D checkout desk (`/city`) does its share of this with `loadStripe` and
 * `stripe.handleNextAction({ clientSecret })`, which takes a client secret and
 * no Elements instance. Under normal conditions there is no Stripe iframe in
 * the game view at all, and the way that stays true is that the loader lives in
 * `lib/stripe.ts` while every card-entry component lives here.
 *
 * ## Why the two editors are mutually exclusive
 *
 * `elements.submit()` validates EVERY element mounted in the group. With the
 * address form and the payment form open at once, pressing "Save card" would
 * fail on an empty address field — a validation error about the wrong form.
 * One `editing` value therefore decides which of the two is on screen, and the
 * single `<Elements>` provider stays mounted underneath both.
 *
 * ## The header is the server's answer, not ours
 *
 * `purchasing.state` comes from `GET /me`, and every mutation below answers
 * with a freshly derived snapshot which is written straight back into the
 * session cache. Nothing in this file computes an eligibility state, including
 * optimistically: the consent checkbox flips before its request lands and
 * reverts if it fails (the `notification-prefs-card.tsx` idiom), but the
 * checkbox is a control, and the badge above it is a verdict. A client verdict
 * would be a permission the server never granted — and the server recomputes
 * and refuses regardless of what is drawn here.
 *
 * ## The address is PII
 *
 * `GET /me` returns a country and a postal code and nothing else, so this form
 * cannot pre-fill and does not try. The draft the buyer types is never logged,
 * never put in a toast, and goes nowhere but the address PUT.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AddressElement, Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "@/hooks/use-toast";
import { getStripe } from "@/lib/stripe";
import { absoluteUrl } from "@/lib/urls";
import {
  EMPTY_ADDRESS_DRAFT,
  PURCHASING_TERMS_QUERY_KEY,
  acceptStoredCardTerms,
  addressDraftFromElement,
  addressDraftIsSavable,
  canSaveCard,
  createSetupIntent,
  fetchPurchasingTerms,
  formatSavedCard,
  purchasingCopy,
  removePaymentMethod,
  savePaymentMethod,
  saveShippingAddress,
  type PurchasingTerms,
  type ShippingAddressDraft,
} from "@/lib/purchasing";
import type { PurchasingSnapshot } from "@workspace/api-client-react";

/** Which sub-form is open. Never two at once — see the note on `elements.submit()`. */
type Editing = "none" | "address" | "card";

const TONE_CLASS: Record<string, string> = {
  ok: "bg-green-500/20 text-green-400",
  advisory: "bg-yellow-500/20 text-yellow-400",
  blocked: "bg-destructive/20 text-destructive",
  off: "bg-secondary text-muted-foreground",
};

/** An error's message, or a sentence. Never a draft field. */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function PhysicalPurchasingCard() {
  const { user, purchasing, applyPurchasing } = useAuth();

  // `disabled` and `anonymous` are the server saying there is nothing to
  // configure: the commerce surface is off (and every purchasing route answers
  // 404), or there is no session. Both are decided before the query
  // below is allowed to fire, so a dashboard on a deployment with commerce off
  // makes no request that could 404 in the console.
  const live =
    !!user &&
    !!purchasing &&
    purchasing.state !== "disabled" &&
    purchasing.state !== "anonymous";

  const termsQuery = useQuery<PurchasingTerms>({
    queryKey: PURCHASING_TERMS_QUERY_KEY,
    queryFn: fetchPurchasingTerms,
    enabled: live,
    // The document changes only when the server is redeployed with a new
    // version, and re-fetching it would re-render the terms box under someone
    // reading it.
    staleTime: Infinity,
    retry: false,
  });
  const terms = termsQuery.data ?? null;

  const [editing, setEditing] = useState<Editing>("none");
  const [showTerms, setShowTerms] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  // The checkbox starts checked when the account has already accepted the
  // version now being served. Seeded from the server's own comparison — the
  // snapshot carries `consentVersion` and the terms carry `version`, and the
  // conclusion drawn from them is the same one `consent_stale` is drawn from.
  const consentIsCurrent = !!terms && purchasing?.consentVersion === terms.version;
  useEffect(() => {
    setConsentAccepted(consentIsCurrent);
  }, [consentIsCurrent]);

  const stripePromise = useMemo(() => getStripe(), []);

  // Deferred intent creation: the provider is configured for a setup, and the
  // SetupIntent itself is not created until the buyer actually presses save.
  // That is what lets the address form and the payment form share one Elements
  // instance — the alternative, passing a `clientSecret` in these options,
  // cannot be changed after mount and would remount (and blank) the address
  // form the moment a card was added.
  const elementsOptions: StripeElementsOptions = useMemo(
    () => ({
      mode: "setup",
      currency: "usd",
      // KAX renders `:root` and `.dark` from the same tokens — there is no
      // light theme to match.
      appearance: { theme: "night" },
    }),
    [],
  );

  // Hydration guard, as in `notification-prefs-card.tsx`: nothing renders until
  // the session read has answered. `purchasing` is absent rather than stale
  // during that window, so there is no wrong state to flash.
  if (!user || !purchasing) return null;
  if (!live) return null;

  const copy = purchasingCopy(purchasing.state);
  const needsConsent = !!terms && purchasing.consentVersion !== terms.version;

  async function handleAcceptTerms() {
    if (!terms) return;
    // Optimistic-then-revert on the CONTROL. The badge above it does not move
    // until the server says so.
    setConsentAccepted(true);
    setConsentBusy(true);
    try {
      applyPurchasing(await acceptStoredCardTerms(terms.version));
      toast({ title: "Terms accepted" });
    } catch (err) {
      setConsentAccepted(false);
      toast({
        title: "Could not record your acceptance",
        description: messageOf(err, "Please try again."),
      });
    } finally {
      setConsentBusy(false);
    }
  }

  async function handleRemoveCard() {
    setRemoving(true);
    try {
      // The header moves to whatever the server derives from the account
      // afterwards — with a detached row now on file that is `pm_detached`,
      // not `needs_payment_method`. Either way it moves without a reload,
      // because the response carries the new snapshot.
      applyPurchasing(await removePaymentMethod());
      setEditing("none");
      toast({ title: "Card removed" });
    } catch (err) {
      toast({
        title: "Could not remove the card",
        description: messageOf(err, "Please try again."),
      });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card id="physical-purchasing" data-testid="physical-purchasing-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base uppercase tracking-wider">Physical Purchasing</CardTitle>
          <p className="text-xs text-muted-foreground mt-1" data-testid="text-purchasing-detail">
            {copy.detail}
          </p>
        </div>
        <span
          className={`px-2 py-1 text-[10px] uppercase tracking-widest whitespace-nowrap ${
            TONE_CLASS[copy.tone] ?? TONE_CLASS["off"]
          }`}
          data-testid="badge-purchasing-state"
        >
          {copy.headline}
        </span>
      </CardHeader>

      <CardContent className="space-y-5">
        {stripePromise === null ? (
          <p className="text-xs text-muted-foreground" data-testid="text-stripe-unconfigured">
            Purchasing is switched on but this build has no Stripe publishable key, so cards cannot
            be entered. Set VITE_STRIPE_PUBLISHABLE_KEY and rebuild.
          </p>
        ) : (
          <Elements stripe={stripePromise} options={elementsOptions}>
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground">
                  Ships to
                </h3>
                {editing !== "address" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing("address")}
                    data-testid="button-edit-address"
                  >
                    {purchasing.shipsTo ? "Replace" : "Add address"}
                  </Button>
                )}
              </div>
              <p className="text-sm font-mono" data-testid="text-purchasing-ships-to">
                {purchasing.shipsTo
                  ? `${purchasing.shipsTo.country} ${purchasing.shipsTo.postalCode}`
                  : "No address on file"}
              </p>
              {editing === "address" && (
                <AddressEditor
                  supportedCountries={terms?.supportedCountries ?? []}
                  onCancel={() => setEditing("none")}
                  onSaved={(snapshot) => {
                    applyPurchasing(snapshot);
                    setEditing("none");
                  }}
                />
              )}
              {/* The street lines are never returned by the server, so an
                  existing address cannot be shown back or edited in place — it
                  is replaced, which is also how the server stores it. */}
              {purchasing.shipsTo && editing !== "address" && (
                <p className="text-[11px] text-muted-foreground">
                  Only the country and postal code of a saved address are ever sent back to this
                  page. Replacing it archives the old one.
                </p>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground">Card</h3>
                <div className="flex items-center gap-2">
                  {purchasing.card && editing !== "card" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRemoveCard}
                      disabled={removing}
                      data-testid="button-remove-card"
                    >
                      {removing ? "Removing…" : "Remove"}
                    </Button>
                  )}
                  {editing !== "card" && (
                    <Button
                      size="sm"
                      onClick={() => setEditing("card")}
                      data-testid="button-add-card"
                    >
                      {purchasing.card ? "Replace card" : "Add card"}
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-sm font-mono" data-testid="text-saved-card">
                {formatSavedCard(purchasing.card)}
              </p>

              {editing === "card" && (
                <CardEditor
                  terms={terms}
                  consentAccepted={consentAccepted}
                  onConsentChange={setConsentAccepted}
                  showTerms={showTerms}
                  onToggleTerms={() => setShowTerms((v) => !v)}
                  needsConsent={needsConsent}
                  onCancel={() => setEditing("none")}
                  onSaved={(snapshot) => {
                    applyPurchasing(snapshot);
                    setEditing("none");
                  }}
                />
              )}
            </section>
          </Elements>
        )}

        {/* Consent can go stale while a card is already saved — the terms are
            rewritten and every existing acceptance is superseded. That is a
            state the card editor cannot clear, because there is no card to add,
            so the acceptance gets its own button here. */}
        {needsConsent && editing !== "card" && (
          <section className="space-y-2 border-t border-border pt-4">
            <h3 className="text-xs uppercase tracking-widest text-muted-foreground">
              Stored-card terms
            </h3>
            <TermsDisclosure
              terms={terms}
              open={showTerms}
              onToggle={() => setShowTerms((v) => !v)}
            />
            <Button
              size="sm"
              onClick={handleAcceptTerms}
              disabled={consentBusy || !terms}
              data-testid="button-accept-terms"
            >
              {consentBusy ? "Saving…" : "Accept these terms"}
            </Button>
          </section>
        )}

        {termsQuery.isError && (
          <p className="text-xs text-destructive" data-testid="text-terms-error">
            Could not load the stored-card terms, so a card cannot be added right now.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The shipping address form: one Stripe Address Element, one Save button.
 *
 * The draft-and-Save idiom of `storefront-settings.tsx` — a local draft and a
 * single explicit save, never per-field autosave — with one deviation forced by
 * the element: there are no individual inputs to write a generic `setField` for,
 * because Stripe owns them. The draft is replaced wholesale from the element's
 * change event instead, which is the same shape of state and the same one Save.
 */
function AddressEditor({
  supportedCountries,
  onCancel,
  onSaved,
}: {
  supportedCountries: string[];
  onCancel: () => void;
  onSaved: (snapshot: PurchasingSnapshot) => void;
}) {
  const [draft, setDraft] = useState<ShippingAddressDraft>(EMPTY_ADDRESS_DRAFT);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      // `draft.validated` carries Stripe's own `complete` verdict through to
      // `validated_at`. Nothing about the address itself is in this call's
      // error path — see `readPurchasingError`.
      onSaved(await saveShippingAddress(draft));
      toast({ title: "Address saved" });
    } catch (err) {
      toast({
        title: "Could not save the address",
        description: messageOf(err, "Please check the fields and try again."),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 border border-border p-3" data-testid="address-editor">
      <AddressElement
        options={{
          mode: "shipping",
          // The server's own `SUPPORTED_SHIP_TO_COUNTRIES`, fetched with the
          // terms. Omitted entirely when the list is empty rather than sent as
          // `[]`, which the element reads as "no country is allowed".
          ...(supportedCountries.length > 0 ? { allowedCountries: supportedCountries } : {}),
          autocomplete: { mode: "automatic" },
          fields: { phone: "always" },
          display: { name: "full" },
        }}
        onChange={(event) => setDraft(addressDraftFromElement(event.value, event.complete))}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={save}
          disabled={saving || !addressDraftIsSavable(draft)}
          data-testid="button-save-address"
        >
          {saving ? "Saving…" : "Save address"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
          data-testid="button-cancel-address"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The card form: consent, then the Payment Element, then one Save.
 *
 * The order of operations on save is the whole point of the component.
 * Acceptance of the terms is recorded BEFORE a SetupIntent is confirmed,
 * because the terms are what say we may keep and charge the card; Stripe's own
 * validation runs before a SetupIntent is created, so an obviously incomplete
 * form does not leave an abandoned intent behind; and the id that finally
 * crosses our wire is the SetupIntent's, never the payment method's.
 */
function CardEditor({
  terms,
  consentAccepted,
  onConsentChange,
  showTerms,
  onToggleTerms,
  needsConsent,
  onCancel,
  onSaved,
}: {
  terms: PurchasingTerms | null;
  consentAccepted: boolean;
  onConsentChange: (value: boolean) => void;
  showTerms: boolean;
  onToggleTerms: () => void;
  needsConsent: boolean;
  onCancel: () => void;
  onSaved: (snapshot: PurchasingSnapshot) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);

  const gate = {
    consentAccepted,
    termsLoaded: !!terms,
    stripeReady: !!stripe && !!elements,
    busy: saving,
  };

  async function save() {
    if (!stripe || !elements || !terms) return;
    // Belt as well as the disabled attribute: a disabled button is a hint, and
    // this is the condition the whole form exists to enforce.
    if (!canSaveCard(gate)) return;

    setSaving(true);
    try {
      if (needsConsent) {
        // Recorded first, and its failure aborts the save. A card saved
        // against an unrecorded agreement is a card we cannot show a reason
        // for having.
        await acceptStoredCardTerms(terms.version);
      }

      const { error: validationError } = await elements.submit();
      if (validationError) {
        toast({
          title: "Check the card details",
          description: validationError.message ?? "Some fields are incomplete.",
        });
        return;
      }

      const clientSecret = await createSetupIntent();

      // `redirect: "if_required"` keeps the buyer on the dashboard: Stripe only
      // navigates away when the bank genuinely demands a redirect, and for a
      // card that needs no challenge this resolves in place. `return_url` is
      // still supplied for the case that does redirect — it comes back to this
      // very card rather than to the top of the dashboard.
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        clientSecret,
        confirmParams: { return_url: absoluteUrl("/dashboard#physical-purchasing") },
        redirect: "if_required",
      });

      if (error) {
        toast({
          title: "Could not save the card",
          description: error.message ?? "Your bank declined the request.",
        });
        return;
      }
      if (!setupIntent) {
        // Only reachable on the redirect branch, where the browser is already
        // navigating and there is nothing left to do here.
        return;
      }

      // The SetupIntent id, and nothing else. The server retrieves the intent,
      // checks its Customer against this account's, and reads the card off it.
      onSaved(await savePaymentMethod(setupIntent.id));
      toast({ title: "Card saved" });
    } catch (err) {
      toast({
        title: "Could not save the card",
        description: messageOf(err, "Please try again."),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 border border-border p-3" data-testid="card-editor">
      <PaymentElement options={{ layout: "tabs" }} />

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={consentAccepted}
            disabled={!terms || saving}
            onChange={(e) => onConsentChange(e.target.checked)}
            data-testid="checkbox-stored-card-consent"
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>
            I agree to the stored-card terms{terms ? ` (${terms.version})` : ""} and to KAX charging
            this card for purchases I place.
          </span>
        </label>
        <TermsDisclosure terms={terms} open={showTerms} onToggle={onToggleTerms} />
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={save}
          disabled={!canSaveCard(gate)}
          data-testid="button-save-card"
        >
          {saving ? "Saving…" : "Save card"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
          data-testid="button-cancel-card"
        >
          Cancel
        </Button>
      </div>
      {!consentAccepted && (
        <p className="text-[11px] text-muted-foreground" data-testid="text-consent-required">
          Accept the terms above before saving a card.
        </p>
      )}
    </div>
  );
}

/**
 * The terms, inline and verbatim.
 *
 * The words come from `GET /me/purchasing/terms`, which serves the same
 * constant the consent row's `terms_sha256` is computed from. Rendering them
 * from anywhere else — a copy in this repo, a link to a marketing page — would
 * make the hash a record of a document nobody displayed.
 */
function TermsDisclosure({
  terms,
  open,
  onToggle,
}: {
  terms: PurchasingTerms | null;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="text-[11px] uppercase tracking-widest text-primary"
        data-testid="button-toggle-terms"
      >
        {open ? "Hide terms" : "Read the terms"}
      </button>
      {open && (
        <pre
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border border-border bg-secondary/40 p-3 text-[11px] leading-relaxed font-mono"
          data-testid="text-stored-card-terms"
        >
          {terms ? terms.markdown : "Loading the terms…"}
        </pre>
      )}
    </div>
  );
}
