import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  friendlyWalletError,
  getInjectedProvider,
  shortAddress,
  walletProviderName,
} from "@/lib/wallet";

function returnTarget(): string {
  if (typeof window === "undefined") return "/dashboard";
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("returnTo");
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/dashboard";
}

type EmailMode = "signin" | "register";

export default function LoginPage() {
  const { user, isLoading, signInWithWallet, signInWithEmail, registerWithEmail } = useAuth();
  const [, navigate] = useLocation();

  // Wallet door state
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const provider = getInjectedProvider();
  const hasWallet = !!provider;
  const providerName = walletProviderName(provider);

  // Email door state
  const [mode, setMode] = useState<EmailMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && user) {
      navigate(returnTarget(), { replace: true });
    }
  }, [user, isLoading, navigate]);

  async function handleConnect() {
    setWalletError(null);
    setWalletBusy(true);
    try {
      await signInWithWallet();
      navigate(returnTarget(), { replace: true });
    } catch (e) {
      setWalletError(friendlyWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    setEmailError(null);
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setEmailError("Enter your email address.");
      return;
    }
    if (mode === "register" && password.length < 8) {
      setEmailError("Password must be at least 8 characters.");
      return;
    }
    if (!password) {
      setEmailError("Enter your password.");
      return;
    }
    setEmailBusy(true);
    try {
      if (mode === "register") {
        await registerWithEmail(cleanEmail, password, displayName);
      } else {
        await signInWithEmail(cleanEmail, password);
      }
      navigate(returnTarget(), { replace: true });
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setEmailBusy(false);
    }
  }

  function switchMode(next: EmailMode) {
    setMode(next);
    setEmailError(null);
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

      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-4xl font-mono">
          <div className="mb-8 text-center">
            <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">
              Market District · Plot 0
            </p>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-login-title">
              Enter the Exchange
            </h1>
            <p className="text-sm text-muted-foreground mt-2">
              Two doors, one account. Use either — or link both later.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2 items-start">
            {/* Door 01 — Wallet */}
            <div className="border border-border bg-card p-6" data-testid="card-wallet-door">
              <p className="text-[10px] uppercase tracking-[0.3em] text-primary mb-2">
                Door 01 · Wallet
              </p>
              <h2 className="text-lg font-bold tracking-tight mb-3">Connect your wallet</h2>
              <p className="text-xs text-muted-foreground leading-relaxed mb-5">
                Sign a free one-time message to prove you own the address. Nothing on-chain, no
                gas, no transaction.
              </p>

              {hasWallet ? (
                <>
                  <Button
                    size="lg"
                    className="w-full h-11 text-xs uppercase tracking-widest"
                    onClick={handleConnect}
                    disabled={walletBusy}
                    data-testid="button-connect-wallet"
                  >
                    {walletBusy ? "Check your wallet…" : "Connect Wallet"}
                  </Button>
                  {providerName && (
                    <p className="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
                      Detected: {providerName}
                    </p>
                  )}
                </>
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
                    No wallet? Use the email door instead — you can link a wallet any time later.
                    Or{" "}
                    <a
                      href="https://metamask.io/download/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                      data-testid="link-install-metamask"
                    >
                      install MetaMask →
                    </a>
                  </p>
                </div>
              )}

              {walletError && (
                <p
                  className="mt-4 text-xs text-destructive border border-destructive/40 px-3 py-2"
                  data-testid="text-login-error"
                >
                  {walletError}
                </p>
              )}

              <button
                type="button"
                onClick={() => setShowExplainer((v) => !v)}
                className="mt-5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                data-testid="button-toggle-explainer"
              >
                {showExplainer ? "Hide" : "What's this?"}
              </button>
              {showExplainer && (
                <div className="mt-3 text-xs text-muted-foreground space-y-2 border-t border-border pt-3">
                  <p>
                    "Sign-In With Ethereum" (SIWE) is a free, off-chain proof. KAX sends a short
                    message containing a one-time random nonce; your wallet signs it locally and
                    KAX recovers your address from the signature. KAX never sees your private key.
                  </p>
                  <p>Already signed in once? Just sign again — nothing to remember.</p>
                </div>
              )}
            </div>

            {/* Door 02 — Email */}
            <div className="border border-border bg-card p-6" data-testid="card-email-door">
              <p className="text-[10px] uppercase tracking-[0.3em] text-accent-foreground mb-2">
                <span className="text-[#E8A33D]">Door 02 · Email</span>
              </p>
              <div className="flex gap-0 mb-4 border border-border">
                <button
                  type="button"
                  onClick={() => switchMode("signin")}
                  className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-widest ${
                    mode === "signin"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid="button-mode-signin"
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("register")}
                  className={`flex-1 px-3 py-2 text-[10px] uppercase tracking-widest border-l border-border ${
                    mode === "register"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid="button-mode-register"
                >
                  Create account
                </button>
              </div>

              <form onSubmit={handleEmailSubmit} className="space-y-3">
                <div>
                  <label
                    htmlFor="login-email"
                    className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
                  >
                    Email
                  </label>
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="h-10 text-sm"
                    data-testid="input-email"
                  />
                </div>
                <div>
                  <label
                    htmlFor="login-password"
                    className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
                  >
                    Password
                  </label>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "register" ? "8+ characters" : "••••••••"}
                    className="h-10 text-sm"
                    data-testid="input-password"
                  />
                </div>
                {mode === "register" && (
                  <div>
                    <label
                      htmlFor="login-display-name"
                      className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
                    >
                      Display name <span className="normal-case">(optional)</span>
                    </label>
                    <Input
                      id="login-display-name"
                      type="text"
                      autoComplete="nickname"
                      maxLength={80}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Shown on your storefront"
                      className="h-10 text-sm"
                      data-testid="input-display-name"
                    />
                  </div>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full h-11 text-xs uppercase tracking-widest"
                  disabled={emailBusy}
                  data-testid="button-email-submit"
                >
                  {emailBusy
                    ? "One moment…"
                    : mode === "register"
                      ? "Create account"
                      : "Sign in"}
                </Button>
              </form>

              {emailError && (
                <p
                  className="mt-4 text-xs text-destructive border border-destructive/40 px-3 py-2"
                  data-testid="text-email-error"
                >
                  {emailError}
                </p>
              )}

              <p className="mt-5 text-[10px] uppercase tracking-widest text-muted-foreground">
                {mode === "register"
                  ? "Already have an account? Use Sign in."
                  : "New here? Create an account in seconds."}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 text-[10px] uppercase tracking-[0.3em] text-muted-foreground flex items-center justify-between">
          <span>wallet or email · one account</span>
          <span data-testid="text-account-hint">
            {user
              ? `Signed in as ${
                  user.walletAddress
                    ? shortAddress(user.walletAddress)
                    : (user.email ?? shortAddress(user.id))
                }`
              : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
