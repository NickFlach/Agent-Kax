import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Forgot-password flow (task #53). Two modes on one page:
 *   - no ?token → request form (email in, generic "check your inbox")
 *   - ?token=…  → confirm form (new password in, POST reset-confirm)
 * The request response is deliberately generic — the server never
 * reveals whether an email has an account.
 */

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // non-JSON body — fall through
  }
  return fallback;
}

function tokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("token");
}

function Shell({ children }: { children: React.ReactNode }) {
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
        <div className="w-full max-w-md font-mono">{children}</div>
      </div>
    </div>
  );
}

function RequestForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const clean = email.trim();
    if (!clean) {
      setError("Enter your email address.");
      return;
    }
    setBusy(true);
    try {
      const res = await postJson("/api/auth/email/reset-request", { email: clean });
      if (!res.ok) {
        throw new Error(await readError(res, "Could not send the reset email. Please try again."));
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="border border-border bg-card p-6" data-testid="card-reset-sent">
        <p className="text-[10px] uppercase tracking-[0.3em] text-primary mb-2">Check your inbox</p>
        <h1 className="text-lg font-bold tracking-tight mb-3">Reset link on its way</h1>
        <p className="text-xs text-muted-foreground leading-relaxed">
          If an account exists for that email, a reset link is on its way. It's valid for 30
          minutes and works once. Don't forget to check spam.
        </p>
        <Link
          href="/login"
          className="mt-5 inline-block text-[10px] uppercase tracking-widest text-primary underline underline-offset-2"
          data-testid="link-back-to-login"
        >
          ← Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="border border-border bg-card p-6" data-testid="card-reset-request">
      <p className="text-[10px] uppercase tracking-[0.3em] text-primary mb-2">Forgot password</p>
      <h1 className="text-lg font-bold tracking-tight mb-3">Reset by email</h1>
      <p className="text-xs text-muted-foreground leading-relaxed mb-5">
        Enter the email on your account and we'll send a single-use reset link. Wallet users don't
        need this — just sign a fresh message on the login page.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label
            htmlFor="reset-email"
            className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
          >
            Email
          </label>
          <Input
            id="reset-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="h-10 text-sm"
            data-testid="input-reset-email"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          className="w-full h-11 text-xs uppercase tracking-widest"
          disabled={busy}
          data-testid="button-reset-request"
        >
          {busy ? "One moment…" : "Send reset link"}
        </Button>
      </form>
      {error && (
        <p
          className="mt-4 text-xs text-destructive border border-destructive/40 px-3 py-2"
          data-testid="text-reset-error"
        >
          {error}
        </p>
      )}
      <Link
        href="/login"
        className="mt-5 inline-block text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        data-testid="link-back-to-login"
      >
        ← Back to sign in
      </Link>
    </div>
  );
}

function ConfirmForm({ token }: { token: string }) {
  const [, navigate] = useLocation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await postJson("/api/auth/email/reset-confirm", {
        token,
        newPassword: password,
      });
      if (!res.ok) {
        throw new Error(
          await readError(res, "Could not reset the password. The link may have expired."),
        );
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="border border-border bg-card p-6" data-testid="card-reset-done">
        <p className="text-[10px] uppercase tracking-[0.3em] text-primary mb-2">Password updated</p>
        <h1 className="text-lg font-bold tracking-tight mb-3">You're back in business</h1>
        <p className="text-xs text-muted-foreground leading-relaxed mb-5">
          Your password has been changed. Sign in with your email and the new password.
        </p>
        <Button
          size="lg"
          className="w-full h-11 text-xs uppercase tracking-widest"
          onClick={() => navigate("/login")}
          data-testid="button-go-to-login"
        >
          Go to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="border border-border bg-card p-6" data-testid="card-reset-confirm">
      <p className="text-[10px] uppercase tracking-[0.3em] text-primary mb-2">Reset password</p>
      <h1 className="text-lg font-bold tracking-tight mb-3">Choose a new password</h1>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label
            htmlFor="reset-new-password"
            className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
          >
            New password
          </label>
          <Input
            id="reset-new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="8+ characters"
            className="h-10 text-sm"
            data-testid="input-new-password"
          />
        </div>
        <div>
          <label
            htmlFor="reset-confirm-password"
            className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
          >
            Confirm new password
          </label>
          <Input
            id="reset-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
            className="h-10 text-sm"
            data-testid="input-confirm-password"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          className="w-full h-11 text-xs uppercase tracking-widest"
          disabled={busy}
          data-testid="button-reset-confirm"
        >
          {busy ? "One moment…" : "Set new password"}
        </Button>
      </form>
      {error && (
        <p
          className="mt-4 text-xs text-destructive border border-destructive/40 px-3 py-2"
          data-testid="text-reset-error"
        >
          {error}
        </p>
      )}
      <Link
        href="/reset-password"
        className="mt-5 inline-block text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        data-testid="link-request-new"
      >
        Link expired? Request a new one
      </Link>
    </div>
  );
}

export default function ResetPasswordPage() {
  const token = useMemo(tokenFromUrl, []);
  return <Shell>{token ? <ConfirmForm token={token} /> : <RequestForm />}</Shell>;
}
