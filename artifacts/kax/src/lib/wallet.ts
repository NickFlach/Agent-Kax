export interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  isMetaMask?: boolean;
  isRabby?: boolean;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export function getInjectedProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

export async function requestAccounts(provider: EthereumProvider): Promise<string[]> {
  const result = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  return Array.isArray(result) ? result : [];
}

export async function personalSign(
  provider: EthereumProvider,
  address: string,
  message: string,
): Promise<string> {
  const sig = (await provider.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;
  return sig;
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Human-readable name of the detected wallet extension. */
export function walletProviderName(provider: EthereumProvider | null): string | null {
  if (!provider) return null;
  // Rabby impersonates MetaMask (sets isMetaMask too) — check it first.
  if (provider.isRabby) return "Rabby";
  if (provider.isMetaMask) return "MetaMask";
  return "browser wallet";
}

/**
 * Map raw EIP-1193 provider errors to copy a human can act on. The
 * two big ones: 4001 (user clicked Cancel — not a failure) and -32002
 * (a permission popup is already open but hidden behind the window).
 */
export function friendlyWalletError(e: unknown): string {
  const code =
    typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined;
  if (code === 4001) return "Request cancelled in your wallet — nothing was sent.";
  if (code === -32002)
    return "Your wallet is already showing a request — find its popup and confirm there.";
  if (e instanceof Error && e.message) return e.message;
  return "Wallet sign-in failed. Please try again.";
}

