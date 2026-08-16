import { useEffect, useState } from "react";
import { Link } from "wouter";

/**
 * Stripe Checkout return pages. Success verifies the session server-side
 * (idempotent) and shows the outcome; cancel just offers a way back.
 */
export function CheckoutSuccessPage() {
  const [status, setStatus] = useState<"loading" | "paid" | "pending" | "canceled" | "error">("loading");

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (!sessionId) {
      setStatus("error");
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/store/orders/confirm?sessionId=${encodeURIComponent(sessionId)}`, {
          credentials: "include",
        });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { status: "paid" | "pending" | "canceled" };
        if (alive) setStatus(j.status);
      } catch {
        if (alive) setStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md text-center" data-testid="checkout-result">
        {status === "loading" && <p className="text-muted-foreground text-sm">Confirming your payment…</p>}
        {status === "paid" && (
          <>
            <h1 className="text-2xl font-bold tracking-tight">Payment complete</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Thank you — your purchase is confirmed.
            </p>
          </>
        )}
        {status === "pending" && (
          <>
            <h1 className="text-2xl font-bold tracking-tight">Payment processing</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Stripe is still processing this payment. Refresh in a moment.
            </p>
          </>
        )}
        {(status === "canceled" || status === "error") && (
          <>
            <h1 className="text-2xl font-bold tracking-tight">
              {status === "canceled" ? "Checkout canceled" : "Could not confirm payment"}
            </h1>
            <p className="text-sm text-muted-foreground mt-2">
              {status === "canceled"
                ? "No charge was made."
                : "If you were charged, the payment will still be recorded — try refreshing, or contact the store."}
            </p>
          </>
        )}
        <Link href="/marketplace" className="text-primary text-sm mt-6 inline-block" data-testid="link-back-market">
          ← Back to the marketplace
        </Link>
      </div>
    </div>
  );
}

export function CheckoutCancelPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold tracking-tight">Checkout canceled</h1>
        <p className="text-sm text-muted-foreground mt-2">No charge was made.</p>
        <Link href="/marketplace" className="text-primary text-sm mt-6 inline-block">
          ← Back to the marketplace
        </Link>
      </div>
    </div>
  );
}
