/**
 * tower-webhooks.test.ts — the egress guard and the signature.
 *
 * The two ways this feature hurts someone: the delivery job becomes an SSRF
 * proxy (a tenant-supplied URL reaching private address space), or a tenant
 * cannot tell the city's deliveries from a forger's. So the address-space
 * refusals and the exact signature format are pinned here, against fixed
 * vectors — not against whatever the implementation happens to produce.
 */

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { backoffMs, ipIsPublicUnicast, newWebhookSecret, signBody, validateWebhookUrl } from "./tower-webhooks-core";

describe("signatures", () => {
  it("signs the exact body with sha256 hmac in the documented format", () => {
    const secret = "twhs_test";
    const body = '{"id":41,"kind":"chat.said"}';
    const expected = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
    expect(signBody(secret, body)).toBe(expected);
    // Any byte difference changes the signature.
    expect(signBody(secret, body + " ")).not.toBe(expected);
    expect(signBody("twhs_other", body)).not.toBe(expected);
  });

  it("mints distinct, prefixed secrets", () => {
    const a = newWebhookSecret();
    const b = newWebhookSecret();
    expect(a.startsWith("twhs_")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });
});

describe("the URL gate", () => {
  it("accepts a plain https receiver", () => {
    const r = validateWebhookUrl("https://hooks.example.com/kax/tower");
    expect(r.ok).toBe(true);
  });

  it("refuses http, userinfo, garbage, and oversize", () => {
    expect(validateWebhookUrl("http://hooks.example.com/x").ok).toBe(false);
    expect(validateWebhookUrl("https://user:pw@hooks.example.com/x").ok).toBe(false);
    expect(validateWebhookUrl("not a url").ok).toBe(false);
    expect(validateWebhookUrl(42 as unknown as string).ok).toBe(false);
    expect(validateWebhookUrl("https://h.example/" + "a".repeat(500)).ok).toBe(false);
  });

  it("refuses IP-literal receivers in private space at registration", () => {
    for (const bad of [
      "https://10.0.0.5/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data", // the cloud metadata service
      "https://192.168.1.10/hook",
      "https://172.16.0.9/hook",
      "https://[::1]/hook",
      "https://[fd00::1]/hook",
    ]) {
      expect(validateWebhookUrl(bad).ok, bad).toBe(false);
    }
    expect(validateWebhookUrl("https://93.184.216.34/hook").ok).toBe(true);
  });
});

describe("public-unicast address test", () => {
  it("refuses every special IPv4 class", () => {
    for (const ip of [
      "0.1.2.3", "10.1.2.3", "127.0.0.1", "100.64.0.1", "100.127.255.255",
      "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1",
      "192.0.0.1", "192.0.2.44", "198.18.0.1", "198.51.100.7", "203.0.113.9",
      "224.0.0.1", "255.255.255.255",
    ]) {
      expect(ipIsPublicUnicast(ip), ip).toBe(false);
    }
  });

  it("accepts ordinary public IPv4", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) {
      expect(ipIsPublicUnicast(ip), ip).toBe(true);
    }
  });

  it("refuses special IPv6 and v4-mapped private, accepts public", () => {
    for (const ip of ["::", "::1", "fe80::1", "fd12::1", "fc00::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"]) {
      expect(ipIsPublicUnicast(ip), ip).toBe(false);
    }
    for (const ip of ["2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(ipIsPublicUnicast(ip), ip).toBe(true);
    }
  });

  it("handles the HEX v4-mapped form Node normalizes to, both ways", () => {
    // Node renders `::ffff:8.8.8.8` as `::ffff:808:808`; a real public
    // receiver must not be refused just because it arrived hex-encoded.
    expect(ipIsPublicUnicast("::ffff:808:808")).toBe(true); // 8.8.8.8
    expect(ipIsPublicUnicast("::ffff:5db8:d822")).toBe(true); // 93.184.216.34
    // …and the private classes are still refused in hex form.
    expect(ipIsPublicUnicast("::ffff:a00:1")).toBe(false); // 10.0.0.1
    expect(ipIsPublicUnicast("::ffff:a9fe:a9fe")).toBe(false); // 169.254.169.254
  });

  it("refuses non-IP strings outright", () => {
    expect(ipIsPublicUnicast("example.com")).toBe(false);
    expect(ipIsPublicUnicast("")).toBe(false);
  });
});

describe("delivery closes the SSRF class at the socket", () => {
  it("dials via https.request with a DNS-pinned vetting lookup (no rebind, no redirects)", async () => {
    // The delivery module imports the db package (throws without DATABASE_URL),
    // so assert the mechanism on the source rather than executing the sweeper.
    const fs = require("node:fs");
    const src = fs.readFileSync(new URL("./tower-webhooks.ts", import.meta.url), "utf8") as string;
    // https.request does not follow redirects, so the fetch-era redirect hole
    // is gone by construction; the lookup vets every resolved address and the
    // socket connects to that same resolution — no TOCTOU window.
    expect(src).toContain("httpsRequest(");
    expect(src).toContain("lookup: vettingLookup");
    expect(src).toContain("ipIsPublicUnicast(a.address)");
    // The success gate is still a strict 2xx, so a 3xx is a failure.
    expect(src).toMatch(/res\.status >= 200 && res\.status < 300/);
    // And an IP-literal host (which Node connects without calling lookup) is
    // vetted inline before the request.
    expect(src).toMatch(/isIP\(bareHost\) && !ipIsPublicUnicast\(bareHost\)/);
  });
});

describe("backoff", () => {
  it("doubles from one minute and caps at an hour", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(3)).toBe(480_000);
    expect(backoffMs(10)).toBe(3_600_000);
  });
});
