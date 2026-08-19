import crypto from "node:crypto";
import type { StorageAdapter, StorageObject } from "./adapter";

/**
 * storage/s3.ts — a minimal S3-compatible client (#264).
 *
 * Deliberately NOT an SDK: the repo has zero storage dependencies and the ADR
 * bans native deps in the bundled deploy. PUT/GET against any S3-compatible
 * endpoint (Supabase Storage's S3 gateway, Cloudflare R2, AWS S3) needs only
 * AWS Signature V4 over HTTPS, which is ~a page of node:crypto. The signing
 * half is pure and exported for tests; only send() touches the network, and
 * fetch is injectable.
 *
 * Path-style addressing on purpose: Supabase and R2 both accept it, and it
 * spares the bucket-in-DNS ambiguity that virtual-hosted style brings to
 * custom endpoints.
 */

export interface S3Config {
  /** e.g. https://<project>.supabase.co/storage/v1/s3 or https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256hex = (data: string | Uint8Array): string =>
  crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string): Buffer =>
  crypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986 encode, keeping the path separators S3 expects intact. */
export function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * AWS Signature V4 for one request. Pure: everything that varies is a
 * parameter, so the test can pin known-good signatures without a network.
 */
export function signV4(input: {
  config: S3Config;
  method: "PUT" | "GET" | "HEAD";
  key: string;
  payloadSha256: string;
  now: Date;
  contentType?: string;
}): SignedRequest {
  const { config } = input;
  const url = new URL(config.endpoint);
  const host = url.host;
  const basePath = url.pathname.replace(/\/$/, "");
  const canonicalUri = `${basePath}/${config.bucket}/${encodeKeyPath(input.key)}`;

  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": amzDate,
  };
  if (input.contentType) headers["content-type"] = input.contentType;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method,
    canonicalUri,
    "", // no query string on plain PUT/GET
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const { host: _h, ...sendHeaders } = headers; // fetch sets Host itself
  return {
    url: `${url.origin}${canonicalUri}`,
    headers: { ...sendHeaders, authorization },
  };
}

export class S3StorageAdapter implements StorageAdapter {
  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const signed = signV4({
      config: this.config,
      method: "PUT",
      key,
      payloadSha256: sha256hex(bytes),
      now: new Date(),
      contentType,
    });
    const res = await this.fetchImpl(signed.url, {
      method: "PUT",
      headers: signed.headers,
      // node's fetch accepts a Uint8Array body; the lib.dom-less typings here
      // only see fetch through its own signature, so derive the body type.
      body: bytes as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"],
    });
    if (!res.ok) {
      throw new Error(`storage PUT ${key} failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
    }
  }

  async get(key: string): Promise<StorageObject | null> {
    const signed = signV4({
      config: this.config,
      method: "GET",
      key,
      payloadSha256: sha256hex(""),
      now: new Date(),
    });
    const res = await this.fetchImpl(signed.url, { method: "GET", headers: signed.headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage GET ${key} failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }
}
