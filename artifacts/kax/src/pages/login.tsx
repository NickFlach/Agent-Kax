import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { getInjectedProvider, shortAddress } from "@/lib/wallet";

function returnTarget(): string {
  if (typeof window === "undefined") return "/dashboard";
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("returnTo");
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/dashboard";
}

export default function LoginPage() {
  const { user, signInWithWallet, isLoading } = useAuth();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const hasWallet = !!getInjectedProvider();

  useEffect(() => {
    if (!isLoading && user) {
      navigate(returnTarget(), { replace: true });
    }
  }, [user, isLoading, navigate]);

  async function handleConnect() {
    setError(null);
    setBusy(true);
    try {
      await signInWithWallet();
      navigate(returnTarget(), { replace: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="font-bold tracking-widest text-sm" data-testid="link-home">
            KAX
          </Link>
          <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground hidden sm:inline">
            Kannaka Artifact Exchange
          </span>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md border border-border bg-card p-8 font-mono">
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">
            Sign in
          </p>
          <h1 className="text-2xl font-bold tracking-tight mb-4" data-testid="text-login-title">
            Connect your wallet
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed mb-6">
            KAX uses your EVM wallet (MetaMask, Rabby, etc.) as your identity. Signing in is free
            and authorizes nothing on-chain — you just sign a one-time message to prove you own the
            address.
          </p>

          {hasWallet ? (
            <Button
              size="lg"
              className="w-full h-11 text-xs uppercase tracking-widest"
              onClick={handleConnect}
              disabled={busy}
              data-testid="button-connect-wallet"
            >
              {busy ? "Waiting for signature…" : "Connect Wallet"}
            </Button>
          ) : (
            <div className="space-y-3" data-testid="no-wallet-fallback">
              <Button
                size="lg"
                variant="outline"
                className="w-full h-11 text-xs uppercase tracking-widest"
                disabled
              >
                No wallet detected
              </Button>
              <p className="text-xs text-muted-foreground">
                Install a browser wallet to continue.{" "}
                <a
                  href="https://metamask.io/download/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                  data-testid="link-install-metamask"
                >
                  Install MetaMask →
                </a>
              </p>
            </div>
          )}

          {error && (
            <p
              className="mt-4 text-xs text-destructive border border-destructive/40 px-3 py-2"
              data-testid="text-login-error"
            >
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => setShowExplainer((v) => !v)}
            className="mt-6 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            data-testid="button-toggle-explainer"
          >
            {showExplainer ? "Hide" : "What's this?"}
          </button>
          {showExplainer && (
            <div className="mt-3 text-xs text-muted-foreground space-y-2 border-t border-border pt-3">
              <p>
                "Sign-In With Ethereum" (SIWE) is a free, off-chain proof. KAX sends a short
                message containing a one-time random nonce; your wallet signs it locally and KAX
                recovers your address from the signature. No transaction is broadcast, no gas is
                paid, and KAX never sees your private key.
              </p>
              <p>
                Already signed in once? Just sign again — there's nothing to remember and nothing
                to publish on OBC.
              </p>
            </div>
          )}

          {hasWallet && window.ethereum?.isMetaMask && (
            <p className="mt-4 text-[10px] uppercase tracking-widest text-muted-foreground">
              Detected: MetaMask
            </p>
          )}
        </div>
      </div>

      <div className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 text-[10px] uppercase tracking-[0.3em] text-muted-foreground flex items-center justify-between">
          <span>v1 · browser wallets only</span>
          <span data-testid="text-account-hint">
            {user ? `Signed in as ${shortAddress(user.walletAddress ?? user.id)}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
