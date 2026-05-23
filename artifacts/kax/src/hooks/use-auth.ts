import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGetCurrentAuthUserQueryKey,
  type AuthUser,
} from "@workspace/api-client-react";
import { getInjectedProvider, personalSign, requestAccounts } from "@/lib/wallet";

export type { AuthUser };

interface AuthEnvelope {
  user: AuthUser | null;
}

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
const AUTH_QUERY_KEY = getGetCurrentAuthUserQueryKey();

async function fetchAuthEnvelope(): Promise<AuthEnvelope> {
  // Use raw fetch (instead of the generated hook) so a 401 collapses to
  // `{ user: null }` rather than throwing — the rest of the SPA treats
  // logged-out as a normal state, not an error.
  const res = await fetch("/api/auth/user", { credentials: "include" });
  if (!res.ok) return { user: null };
  return (await res.json()) as AuthEnvelope;
}

export function useAuth(): AuthState {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery<AuthEnvelope>({
    queryKey: AUTH_QUERY_KEY,
    queryFn: fetchAuthEnvelope,
    staleTime: 30_000,
    retry: false,
  });

  const user = data?.user ?? null;

  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

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
      qc.setQueryData(AUTH_QUERY_KEY, { user: null } satisfies AuthEnvelope);
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
    qc.setQueryData(AUTH_QUERY_KEY, { user: signedIn } satisfies AuthEnvelope);
    // Invalidate every other cached query so authed views refetch with cookies.
    qc.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey;
        return !(Array.isArray(k) && k[0] === AUTH_QUERY_KEY[0]);
      },
    });
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
