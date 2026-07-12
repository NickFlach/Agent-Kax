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
  signInWithEmail: (email: string, password: string) => Promise<AuthUser>;
  registerWithEmail: (email: string, password: string, displayName?: string) => Promise<AuthUser>;
  /** Attach a wallet to the signed-in account (does not change the session). */
  linkWallet: () => Promise<void>;
  /** Set email + password on the signed-in account. */
  linkEmail: (email: string, password: string) => Promise<void>;
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

/** Pull the server's `{ error }` message out of a failed response. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // non-JSON body — fall through
  }
  return fallback;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Run the SIWE proof dance (request accounts → fetch nonce → sign) and
 * return the pieces the server needs. Shared by sign-in and linking.
 */
async function buildWalletProof(): Promise<{ address: string; signature: string; nonce: string }> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error(
      "No browser wallet detected. Install MetaMask, Rabby, or another EVM wallet extension to continue.",
    );
  }
  const accounts = await requestAccounts(provider);
  const address = accounts[0];
  if (!address) throw new Error("Wallet did not return an address.");

  const nonceRes = await postJson("/api/auth/wallet/nonce", { address });
  if (!nonceRes.ok) throw new Error(`Could not start sign-in (HTTP ${nonceRes.status}).`);
  const { message, nonce } = (await nonceRes.json()) as { message: string; nonce: string };

  const signature = await personalSign(provider, address, message);
  return { address, signature, nonce };
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
    window.location.href = target;
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "include" }).catch(
        () => undefined,
      );
    } finally {
      qc.setQueryData(AUTH_QUERY_KEY, { user: null } satisfies AuthEnvelope);
      qc.clear();
      window.location.href = `${BASE}/`;
    }
  }, [qc]);

  // After any sign-in: seed the auth query and refetch everything else
  // so authed views reload with the new session cookie.
  const applySignedIn = useCallback(
    (signedIn: AuthUser) => {
      qc.setQueryData(AUTH_QUERY_KEY, { user: signedIn } satisfies AuthEnvelope);
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return !(Array.isArray(k) && k[0] === AUTH_QUERY_KEY[0]);
        },
      });
    },
    [qc],
  );

  const signInWithWallet = useCallback(async (): Promise<AuthUser> => {
    const { address, signature, nonce } = await buildWalletProof();
    // POST `nonce` (not `message`) — the server rebuilds the canonical
    // SIWE text from its stored payload and ignores any client-supplied
    // message. See migration 0004 / commit 0c0e567 (SIWE phishing fix).
    const verifyRes = await postJson("/api/auth/wallet/verify", { address, signature, nonce });
    if (!verifyRes.ok) {
      throw new Error(await readError(verifyRes, "Signature was rejected. Please try again."));
    }
    const { user: signedIn } = (await verifyRes.json()) as { user: AuthUser };
    applySignedIn(signedIn);
    return signedIn;
  }, [applySignedIn]);

  const signInWithEmail = useCallback(
    async (email: string, password: string): Promise<AuthUser> => {
      const res = await postJson("/api/auth/email/login", { email, password });
      if (!res.ok) {
        throw new Error(await readError(res, "Sign-in failed. Please try again."));
      }
      const { user: signedIn } = (await res.json()) as { user: AuthUser };
      applySignedIn(signedIn);
      return signedIn;
    },
    [applySignedIn],
  );

  const registerWithEmail = useCallback(
    async (email: string, password: string, displayName?: string): Promise<AuthUser> => {
      const body: Record<string, string> = { email, password };
      const trimmed = displayName?.trim();
      if (trimmed) body.displayName = trimmed;
      const res = await postJson("/api/auth/email/register", body);
      if (!res.ok) {
        throw new Error(await readError(res, "Could not create the account. Please try again."));
      }
      const { user: signedIn } = (await res.json()) as { user: AuthUser };
      applySignedIn(signedIn);
      return signedIn;
    },
    [applySignedIn],
  );

  const linkWallet = useCallback(async (): Promise<void> => {
    const { address, signature, nonce } = await buildWalletProof();
    const res = await postJson("/api/auth/link/wallet", { address, signature, nonce });
    if (!res.ok) {
      throw new Error(await readError(res, "Could not link the wallet. Please try again."));
    }
    await refetch();
  }, [refetch]);

  const linkEmail = useCallback(
    async (email: string, password: string): Promise<void> => {
      const res = await postJson("/api/auth/link/email", { email, password });
      if (!res.ok) {
        throw new Error(await readError(res, "Could not set the email sign-in. Please try again."));
      }
      await refetch();
    },
    [refetch],
  );

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    logout,
    signInWithWallet,
    signInWithEmail,
    registerWithEmail,
    linkWallet,
    linkEmail,
    refresh,
  };
}
