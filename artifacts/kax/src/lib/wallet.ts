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

