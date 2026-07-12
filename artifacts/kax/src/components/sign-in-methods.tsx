import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  friendlyWalletError,
  getInjectedProvider,
  shortAddress,
} from "@/lib/wallet";

/**
 * "Sign-in methods" card (task #52): shows which doors — wallet and
 * email + password — are attached to the account, and lets the user
 * link the missing one. One users row, both methods.
 */
export function SignInMethodsCard() {
  const { user, linkWallet, linkEmail, changePassword } = useAuth();

  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [showChangeForm, setShowChangeForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeDone, setChangeDone] = useState(false);

  if (!user) return null;

  const walletLinked = Boolean(user.walletAddress);
  const emailLinked = Boolean(user.hasPassword);
  const lockedEmail = user.email ?? "";

  async function handleLinkWallet() {
    setWalletError(null);
    if (!getInjectedProvider()) {
      setWalletError("No browser wallet detected. Install MetaMask or Rabby first.");
      return;
    }
    setWalletBusy(true);
    try {
      await linkWallet();
    } catch (e) {
      setWalletError(friendlyWalletError(e));
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setChangeError(null);
    setChangeDone(false);
    if (!currentPassword) {
      setChangeError("Enter your current password.");
      return;
    }
    if (newPassword.length < 8) {
      setChangeError("New password must be at least 8 characters.");
      return;
    }
    setChangeBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setShowChangeForm(false);
      setCurrentPassword("");
      setNewPassword("");
      setChangeDone(true);
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : "Could not change the password.");
    } finally {
      setChangeBusy(false);
    }
  }

  async function handleLinkEmail(e: FormEvent) {
    e.preventDefault();
    setEmailError(null);
    const cleanEmail = (lockedEmail || email).trim();
    if (!cleanEmail) {
      setEmailError("Enter an email address.");
      return;
    }
    if (password.length < 8) {
      setEmailError("Password must be at least 8 characters.");
      return;
    }
    setEmailBusy(true);
    try {
      await linkEmail(cleanEmail, password);
      setShowEmailForm(false);
      setPassword("");
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Could not set the email sign-in.");
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <div className="border border-border bg-card p-6 font-mono" data-testid="card-signin-methods">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">
        Account
      </p>
      <h2 className="text-lg font-bold tracking-tight mb-4">Sign-in methods</h2>

      <div className="space-y-4">
        {/* Wallet method */}
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-widest">Wallet</p>
            <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-wallet-status">
              {walletLinked
                ? `Linked · ${shortAddress(user.walletAddress!)}`
                : "Not linked — connect an EVM wallet to sign in with it."}
            </p>
          </div>
          {walletLinked ? (
            <span className="text-[10px] uppercase tracking-widest text-primary">Linked</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="text-[10px] uppercase tracking-widest"
              onClick={handleLinkWallet}
              disabled={walletBusy}
              data-testid="button-link-wallet"
            >
              {walletBusy ? "Check your wallet…" : "Link wallet"}
            </Button>
          )}
        </div>
        {walletError && (
          <p
            className="text-xs text-destructive border border-destructive/40 px-3 py-2"
            data-testid="text-link-wallet-error"
          >
            {walletError}
          </p>
        )}

        {/* Email method */}
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-widest">Email + password</p>
            <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-email-status">
              {emailLinked
                ? `Linked · ${user.email ?? ""}`
                : "Not set — add an email and password as a second way in."}
            </p>
          </div>
          {emailLinked ? (
            <div className="flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-widest text-primary">Linked</span>
              <Button
                size="sm"
                variant="outline"
                className="text-[10px] uppercase tracking-widest"
                onClick={() => {
                  setChangeError(null);
                  setChangeDone(false);
                  setShowChangeForm((v) => !v);
                }}
                data-testid="button-show-change-password"
              >
                {showChangeForm ? "Cancel" : "Change password"}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="text-[10px] uppercase tracking-widest"
              onClick={() => setShowEmailForm((v) => !v)}
              data-testid="button-show-link-email"
            >
              {showEmailForm ? "Cancel" : "Add email sign-in"}
            </Button>
          )}
        </div>

        {emailLinked && changeDone && !showChangeForm && (
          <p
            className="text-xs text-primary border border-primary/40 px-3 py-2"
            data-testid="text-change-password-success"
          >
            Password changed.
          </p>
        )}

        {emailLinked && showChangeForm && (
          <form
            onSubmit={handleChangePassword}
            className="space-y-3 border border-border px-4 py-4"
          >
            <div>
              <label
                htmlFor="current-password"
                className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
              >
                Current password
              </label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Your current password"
                className="h-10 text-sm"
                data-testid="input-current-password"
              />
            </div>
            <div>
              <label
                htmlFor="new-password"
                className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
              >
                New password
              </label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="8+ characters"
                className="h-10 text-sm"
                data-testid="input-new-password"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="text-[10px] uppercase tracking-widest"
              disabled={changeBusy}
              data-testid="button-change-password"
            >
              {changeBusy ? "Saving…" : "Change password"}
            </Button>
            {changeError && (
              <p
                className="text-xs text-destructive border border-destructive/40 px-3 py-2"
                data-testid="text-change-password-error"
              >
                {changeError}
              </p>
            )}
          </form>
        )}

        {!emailLinked && showEmailForm && (
          <form onSubmit={handleLinkEmail} className="space-y-3 border border-border px-4 py-4">
            <div>
              <label
                htmlFor="link-email"
                className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
              >
                Email
              </label>
              <Input
                id="link-email"
                type="email"
                autoComplete="email"
                value={lockedEmail || email}
                disabled={Boolean(lockedEmail)}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-10 text-sm"
                data-testid="input-link-email"
              />
              {lockedEmail && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Uses the email already on your account.
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="link-password"
                className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1"
              >
                Password
              </label>
              <Input
                id="link-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8+ characters"
                className="h-10 text-sm"
                data-testid="input-link-password"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="text-[10px] uppercase tracking-widest"
              disabled={emailBusy}
              data-testid="button-link-email"
            >
              {emailBusy ? "Saving…" : "Set email sign-in"}
            </Button>
            {emailError && (
              <p
                className="text-xs text-destructive border border-destructive/40 px-3 py-2"
                data-testid="text-link-email-error"
              >
                {emailError}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
