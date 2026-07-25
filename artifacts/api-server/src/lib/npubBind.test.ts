import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { npubBindDigest, npubToXOnlyHex, verifyNpubBinding } from "./npubBind";

describe("npubToXOnlyHex", () => {
  // Cross-implementation vectors: these npubs were bech32-ENCODED by the Rust
  // k256 signer (`kannaka nostr keygen`), which printed the paired hex. Our
  // decoder must recover exactly that hex — proving the two implementations
  // agree on the NIP-19 encoding.
  const vectors: [string, string][] = [
    [
      "npub1gjgvsj2jv7ldmp7dyjpww9gmskqmx4tsg40yuz6wtvw2kys22qfs8d5h3v",
      "4490c8495267bedd87cd2482e7151b8581b35570455e4e0b4e5b1cab120a5013",
    ],
    [
      "npub1nnzgv7p3egjwtzdyzwmf536fh2s7q6p2pjxtk6mvfa4fxvz8kmwq43hapd",
      "9cc4867831ca24e589a413b69a4749baa1e0682a0c8cbb6b6c4f6a933047b6dc",
    ],
    [
      "npub1j9t89fsgkpascqdezsrlw3p743jmkks084g6d0drzwuxaz3qaq6qx8w8dz",
      "915672a608b07b0c01b91407f7443eac65bb5a0f3d51a6bda313b86e8a20e834",
    ],
  ];
  it.each(vectors)("decodes %s to the Rust-encoded hex", (npub, hex) => {
    expect(npubToXOnlyHex(npub)).toBe(hex);
  });
  it("rejects a bad checksum", () => {
    expect(
      npubToXOnlyHex("npub1gjgvsj2jv7ldmp7dyjpww9gmskqmx4tsg40yuz6wtvw2kys22qfs8d5h3w"),
    ).toBeNull();
  });
  it("rejects a non-npub hrp and garbage", () => {
    expect(npubToXOnlyHex("nsec1qqqq")).toBeNull();
    expect(npubToXOnlyHex("not-bech32")).toBeNull();
    expect(npubToXOnlyHex("")).toBeNull();
  });
});

describe("npubBindDigest", () => {
  const params = {
    domain: "kax.ninja-portal.com",
    npub: "npub1j9t89fsgkpascqdezsrlw3p743jmkks084g6d0drzwuxaz3qaq6qx8w8dz",
    botId: "0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7",
    userId: "user-abc",
    nonce: "0011223344556677",
  };
  it("is deterministic and 32 bytes", () => {
    const a = npubBindDigest(params);
    const b = npubBindDigest({ ...params });
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });
  it("changes with any field", () => {
    const base = npubBindDigest(params).toString("hex");
    expect(npubBindDigest({ ...params, nonce: "0011223344556678" }).toString("hex")).not.toBe(base);
    expect(npubBindDigest({ ...params, botId: "0f05e10b-0000-46d6-b4a2-a7d4bae837f7" }).toString("hex")).not.toBe(base);
    expect(npubBindDigest({ ...params, domain: "evil.example" }).toString("hex")).not.toBe(base);
  });
});

describe("verifyNpubBinding", () => {
  // Sign with @noble as the client would, verify through the lib.
  function bind() {
    const sk = schnorr.utils.randomPrivateKey();
    const pubHex = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
    // Build an npub from the pubkey for the params (encode via the same alphabet
    // is out of scope here — the lib decodes npub→hex, so we craft params whose
    // npub decodes to pubHex by round-tripping through a known-good encoder is
    // unnecessary: verifyNpubBinding decodes the npub we pass. So we must pass a
    // real npub for this pubkey.)
    return { sk, pubHex };
  }

  it("accepts a valid signature and rejects tampering", () => {
    // Use a fixed known keypair vector (npub + its hex) so we can sign with the
    // matching secret. Derive the secret is not possible from a public vector,
    // so instead: generate a key, encode its npub via bech32 using the lib's
    // inverse is not exposed — so we verify the digest path with @noble against
    // a params.npub that decodes to the signing pubkey. We obtain that npub by
    // encoding here with a tiny local bech32 encoder mirrored from the decoder.
    const { sk, pubHex } = bind();
    const npub = encodeNpub(pubHex);
    // sanity: the lib decodes our npub back to the signing key
    expect(npubToXOnlyHex(npub)).toBe(pubHex);

    const params = {
      domain: "kax.ninja-portal.com",
      botId: "0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7",
      userId: "user-xyz",
      nonce: "deadbeefcafebabe",
    };
    const digest = npubBindDigest({ npub, ...params });
    const sig = Buffer.from(schnorr.sign(digest, sk)).toString("hex");

    expect(verifyNpubBinding({ npub, sigHex: sig, ...params })).toBe(true);
    // wrong nonce
    expect(verifyNpubBinding({ npub, sigHex: sig, ...params, nonce: "0000000000000000" })).toBe(false);
    // wrong bot
    expect(verifyNpubBinding({ npub, sigHex: sig, ...params, botId: "00000000-0000-0000-0000-000000000000" })).toBe(false);
    // malformed sig
    expect(verifyNpubBinding({ npub, sigHex: "zz", ...params })).toBe(false);
  });
});

// Minimal bech32 npub encoder — TEST ONLY, to produce an npub for a generated
// key so we can sign with its secret. Mirrors the decoder in npubBind.ts.
function encodeNpub(hex: string): string {
  const ALPH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = convert(Array.from(Buffer.from(hex, "hex")), 8, 5, true);
  const checksum = createChecksum("npub", data);
  return "npub1" + data.concat(checksum).map((d) => ALPH[d]).join("");
}
function convert(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}
function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const out: number[] = [];
  for (let p = 0; p < 6; p++) out.push((mod >> (5 * (5 - p))) & 31);
  return out;
}
