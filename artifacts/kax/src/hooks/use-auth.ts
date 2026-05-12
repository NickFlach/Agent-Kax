import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "@workspace/api-client-react";
import { getInjectedProvider, personalSign, requestAccounts } from "@/lib/wallet";

export type { AuthUser };

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => void;
  logout: () => Promise<void>;
  signInWithWallet: () => Promise<AuthUser>;
  refresh: () => Promise<void>;
}

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "") || "";

async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/user", { credentials: "include" });
  if (!res.ok) return null;
  const data = (await res.json()) as { user: AuthUser | null };
  return data.user ?? null;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    const u = await fetchCurrentUser();
    setUser(u);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then((u) => {
        if (!cancelled) {
          setUser(u);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(() => {
    const target = `${BASE}/login`;
    window.location.href = target || "/login";
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "include" }).catch(
        () => undefined,
      );
    } finally {
      setUser(null);
      qc.clear();
      const target = `${BASE}/` || "/";
      window.location.href = target;
    }
  }, [qc]);

  const signInWithWallet = useCallback(async (): Promise<AuthUser> => {
    const provider = getInjectedProvider();
    if (!provider) {
      throw new Error(
        "No browser wallet detected. Install MetaMask, Rabby, or another EVM wallet extension to continue.",
      );
    }
    const accounts = await requestAccounts(provider);
    const address = accounts[0];
    if (!address) throw new Error("Wallet did not return an address.");

    const nonceRes = await fetch("/api/auth/wallet/nonce", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (!nonceRes.ok) throw new Error(`Could not start sign-in (HTTP ${nonceRes.status}).`);
    const { message, nonce } = (await nonceRes.json()) as { message: string; nonce: string };

    const signature = await personalSign(provider, address, message);

    // POST `nonce` (not `message`) — the server rebuilds the canonical
    // SIWE text from its stored payload and ignores any client-supplied
    // message. See migration 0004 / commit 0c0e567 (SIWE phishing fix).
    const verifyRes = await fetch("/api/auth/wallet/verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, signature, nonce }),
    });
    if (!verifyRes.ok) {
      const text = await verifyRes.text().catch(() => "");
      throw new Error(text || "Signature was rejected. Please try again.");
    }
    const { user: signedIn } = (await verifyRes.json()) as { user: AuthUser };
    setUser(signedIn);
    qc.clear();
    return signedIn;
  }, [qc]);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    logout,
    signInWithWallet,
    refresh,
  };
}
