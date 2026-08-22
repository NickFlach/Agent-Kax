import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/**
 * The pure half of the tower webhook feed (KAX-ADR-0005 Phase 1): signature,
 * secret mint, URL gate, address-space test, backoff. No I/O and no db
 * import, so the SSRF refusals and the signature format can be pinned by
 * tests without an environment. The delivery machinery lives in
 * tower-webhooks.ts, which imports these.
 */

export const TOWER_EVENT_KINDS = ["chat.said", "lease.granted", "lease.dark", "lease.undark", "lease.ended", "panel.updated"] as const;
export type TowerEventKind = (typeof TOWER_EVENT_KINDS)[number];

export function newWebhookSecret(): string {
  return `twhs_${randomBytes(32).toString("base64url")}`;
}

/** `sha256=<hex hmac>` over the exact bytes the tenant receives. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * Syntactic gate for a tenant-supplied receiver URL. The address-space gate
 * runs separately at delivery time, because DNS answers change and a check
 * done only at registration is a promise about the past.
 */
export function validateWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length > 500) return { ok: false, error: "webhook url must be a string of at most 500 chars" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "webhook url must be a valid absolute URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "webhook url must be https" };
  if (u.username || u.password) return { ok: false, error: "webhook url must not carry userinfo" };
  if (!u.hostname) return { ok: false, error: "webhook url must have a hostname" };
  // An IP literal must already be public — no point storing one the delivery
  // gate will refuse forever.
  const bare = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) && !ipIsPublicUnicast(bare)) {
    return { ok: false, error: "webhook host must be public address space" };
  }
  return { ok: true, url: u.toString() };
}

/** Is this textual IP in public unicast space? Refuses every private/special class. */
export function ipIsPublicUnicast(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false; // this-net, private, loopback
    if (a === 100 && b! >= 64 && b! <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local (cloud metadata lives here)
    if (a === 172 && b! >= 16 && b! <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 192 && b === 0) return false; // IETF special + doc (192.0.0.0/24, 192.0.2.0/24)
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false; // doc (198.51.100.0/24)
    if (a === 203 && b === 0) return false; // doc (203.0.113.0/24)
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return false; // unspecified, loopback
    if (low.startsWith("::ffff:")) {
      // v4-mapped, two forms: dotted (::ffff:8.8.8.8) and the hex Node
      // normalizes it to (::ffff:808:808). Recover the embedded v4 either way
      // and test THAT — a hex-form public address must not be refused as if
      // it were a private IPv6.
      const tail = low.slice(7);
      if (tail.includes(".")) return ipIsPublicUnicast(tail);
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
      if (m) {
        const hi = parseInt(m[1]!, 16);
        const lo = parseInt(m[2]!, 16);
        return ipIsPublicUnicast(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
      }
      return false;
    }
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return false; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return false; // ULA
    if (low.startsWith("ff")) return false; // multicast
    if (low.startsWith("2001:db8")) return false; // doc
    return true;
  }
  return false;
}

/** Exponential backoff: 1m, 2m, 4m … capped at ~1h. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts), 3_600_000);
}
