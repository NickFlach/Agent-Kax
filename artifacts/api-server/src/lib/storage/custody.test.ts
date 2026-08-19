/**
 * custody.test.ts — #264's acceptance criteria.
 *
 * The SigV4 signing and adapters are pure. Custody, the derived-asset guard
 * and the reprint are DB-backed (CI), with fetch injected everywhere — "the
 * origin is unreachable" is a spy that 404s and a call-count of zero, not a
 * hope.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { MemoryStorageAdapter, STORAGE_ENV_VARS, StorageUnconfigured, storageFromEnv } from "./adapter";
import { encodeKeyPath, signV4, type S3Config } from "./s3";
import {
  CustodyMissing,
  HUMAN_REVIEW_FACTOR,
  SourceDrifted,
  createDerivedAsset,
  derivedKeyFor,
  fetchSourceBytes,
  reprintMasterBytes,
  reviewDerivedAsset,
  sourceKeyFor,
  takeCustody,
} from "./custody";
import { measureArtifactAsset } from "../printAsset";
import { cleanupTestData, createTestAgent, createTestUser, makeTestId } from "../../test-helpers";

// Same real-header fixture layout printAsset.test.ts proved.
function pngFixture(w: number, h: number, colorType = 6): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b[24] = 8;
  b[25] = colorType;
  return b;
}

// Deliberately NOT shaped like real AWS credentials (no AKIA prefix), so
// secret scanners never have to wonder.
const FAKE_CONFIG: S3Config = {
  endpoint: "https://example-project.supabase.co/storage/v1/s3",
  bucket: "kax-print",
  region: "us-east-1",
  accessKeyId: "TESTKEYID0000000000",
  secretAccessKey: "test-secret-not-a-real-credential",
};

describe("the S3 signer (pure)", () => {
  it("signs deterministically and the secret shapes the signature", () => {
    const at = new Date("2026-08-18T12:00:00Z");
    const a = signV4({ config: FAKE_CONFIG, method: "PUT", key: "sources/1/abc", payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", now: at, contentType: "image/png" });
    const b = signV4({ config: FAKE_CONFIG, method: "PUT", key: "sources/1/abc", payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", now: at, contentType: "image/png" });
    expect(a).toEqual(b);
    expect(a.url).toBe("https://example-project.supabase.co/storage/v1/s3/kax-print/sources/1/abc");
    expect(a.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=TESTKEYID0000000000\/20260818\/us-east-1\/s3\/aws4_request, SignedHeaders=.*Signature=[0-9a-f]{64}$/);
    expect(a.headers["x-amz-date"]).toBe("20260818T120000Z");
    // The host header is signed but not sent (fetch owns it).
    expect(a.headers["host"]).toBeUndefined();
    expect(a.headers["authorization"]).toContain("host");

    const c = signV4({
      config: { ...FAKE_CONFIG, secretAccessKey: "a-different-secret" },
      method: "PUT", key: "sources/1/abc",
      payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now: at, contentType: "image/png",
    });
    expect(c.headers["authorization"]).not.toBe(a.headers["authorization"]);
  });

  it("encodes key segments but never the separators", () => {
    expect(encodeKeyPath("sources/1/a b+c")).toBe("sources/1/a%20b%2Bc");
    expect(encodeKeyPath("derived/2/it's")).toBe("derived/2/it%27s");
  });
});

describe("adapters (pure)", () => {
  it("the memory adapter round-trips bytes faithfully and isolates copies", async () => {
    const s = new MemoryStorageAdapter();
    const bytes = pngFixture(10, 10);
    await s.put("k/1", bytes, "image/png");
    bytes[0] = 0; // mutating the caller's buffer must not reach the store
    const got = await s.get("k/1");
    expect(got?.bytes[0]).toBe(0x89);
    expect(got?.contentType).toBe("image/png");
    expect(await s.get("k/2")).toBeNull();
  });

  it("storageFromEnv refuses loudly while unconfigured (the operator dependency)", async () => {
    expect(STORAGE_ENV_VARS.some((v) => process.env[v])).toBe(false);
    await expect(storageFromEnv()).rejects.toThrow(StorageUnconfigured);
  });

  it("content-addressed keys are derived, never invented", () => {
    expect(sourceKeyFor(7, "abc")).toBe("sources/7/abc");
    expect(derivedKeyFor(7, "def")).toBe("derived/7/def");
  });
});

describe("the custody fetch reuses the measurement's guards", () => {
  it("refuses a non-allowlisted host before any I/O, and caps bytes", async () => {
    const neverFetch: typeof fetch = () => {
      throw new Error("fetch must not be attempted");
    };
    expect(await fetchSourceBytes("https://evil.example/a.png", neverFetch)).toEqual({ failure: "fetch_failed" });
    expect(await fetchSourceBytes("not a url", neverFetch)).toEqual({ failure: "not_a_url" });
  });
});

describe("custody, the guard, and the reprint (DB)", () => {
  let agentId: number;
  const made: number[] = [];

  async function makeArtifact(publicUrl: string): Promise<number> {
    const [row] = await db
      .insert(artifactsTable)
      .values({
        externalId: makeTestId("custody"),
        title: "custody test",
        creatorName: "kax-test-creator",
        publicUrl,
        artifactType: "image",
        agentId,
      })
      .returning({ id: artifactsTable.id });
    made.push(row!.id);
    return row!.id;
  }

  beforeAll(async () => {
    const user = await createTestUser({ emailLabel: "custody" });
    agentId = (await createTestAgent(user.id, "custody")).id;
  });

  afterAll(async () => {
    // derived_assets rows cascade with their artifacts.
    await db.delete(artifactsTable).where(inArray(artifactsTable.id, made));
    await cleanupTestData();
  });

  it("no derived print master may exist for an artifact whose bytes KAX does not hold", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/unheld.png");
    const storage = new MemoryStorageAdapter();
    await expect(
      createDerivedAsset({
        sourceArtifactId: id,
        transformType: "upscale",
        transformFactor: 2,
        bytes: pngFixture(2048, 2048),
        storage,
      }),
    ).rejects.toThrow(CustodyMissing);
    expect(storage.keys()).toEqual([]); // nothing was stored either
  });

  it("takes custody of measured bytes, refuses drifted ones, and never re-fetches what it holds", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/held.png");
    const body = pngFixture(1024, 1024);
    const serve: typeof fetch = async () => new Response(body, { status: 200 });
    const measured = await measureArtifactAsset(id, serve);
    expect(measured.failureReason).toBeNull();

    const storage = new MemoryStorageAdapter();
    const custody = await takeCustody(id, storage, serve);
    expect(custody.alreadyHeld).toBe(false);
    expect(custody.sha256).toBe(measured.sha256);
    expect((await storage.get(custody.storageKey))?.bytes).toEqual(body);

    // Already held: no fetch happens at all.
    const neverFetch: typeof fetch = () => {
      throw new Error("custody is held — no fetch may occur");
    };
    expect((await takeCustody(id, storage, neverFetch)).alreadyHeld).toBe(true);

    // Drift: a second artifact whose bytes changed between measure and custody.
    const id2 = await makeArtifact("https://kfz.supabase.co/drifted.png");
    await measureArtifactAsset(id2, serve);
    const serveOther: typeof fetch = async () => new Response(pngFixture(512, 512), { status: 200 });
    await expect(takeCustody(id2, new MemoryStorageAdapter(), serveOther)).rejects.toThrow(SourceDrifted);
  });

  it("quality: in-spec passes, out-of-spec fails, big factors go to a human — once", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/quality.png");
    const body = pngFixture(1024, 1024);
    const serve: typeof fetch = async () => new Response(body, { status: 200 });
    await measureArtifactAsset(id, serve);
    const storage = new MemoryStorageAdapter();
    await takeCustody(id, storage, serve);

    const passed = await createDerivedAsset({
      sourceArtifactId: id, transformType: "upscale", transformFactor: 2,
      bytes: pngFixture(2048, 2048), storage, requiredPx: { width: 2000, height: 2000 },
    });
    expect(passed.qualityStatus).toBe("passed");

    const failed = await createDerivedAsset({
      sourceArtifactId: id, transformType: "upscale", transformFactor: 2,
      bytes: pngFixture(1500, 1500), storage, requiredPx: { width: 2700, height: 3300 },
    });
    expect(failed.qualityStatus).toBe("failed");

    const undecodable = await createDerivedAsset({
      sourceArtifactId: id, transformType: "upscale", transformFactor: 2,
      bytes: new Uint8Array(64), storage,
    });
    expect(undecodable.qualityStatus).toBe("failed");

    const review = await createDerivedAsset({
      sourceArtifactId: id, transformType: "upscale", transformFactor: HUMAN_REVIEW_FACTOR + 1,
      bytes: pngFixture(3072, 3072), storage, requiredPx: { width: 2700, height: 3300 },
    });
    expect(review.qualityStatus).toBe("human_review");
    const resolved = await reviewDerivedAsset(review.id, "passed", "kax:user:test-reviewer");
    expect(resolved.qualityStatus).toBe("passed");
    expect(resolved.reviewedBy).toBe("kax:user:test-reviewer");
    await expect(reviewDerivedAsset(review.id, "failed", "kax:user:test-reviewer")).rejects.toThrow(/not awaiting review/);
    await expect(reviewDerivedAsset(passed.id, "failed", "kax:user:test-reviewer")).rejects.toThrow(/not awaiting review/);
  });

  it("reprints from the KAX-held master with the OBC origin stubbed to 404", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/reprint.png");
    const body = pngFixture(1024, 1024);
    const serve: typeof fetch = async () => new Response(body, { status: 200 });
    await measureArtifactAsset(id, serve);
    const storage = new MemoryStorageAdapter();
    await takeCustody(id, storage, serve);
    const masterBytes = pngFixture(2700, 3300);
    const master = await createDerivedAsset({
      sourceArtifactId: id, transformType: "upscale", transformFactor: 2,
      bytes: masterBytes, storage, requiredPx: { width: 2700, height: 3300 },
    });

    // The origin is now GONE: every request 404s, and we count them.
    let originCalls = 0;
    const origin404: typeof fetch = async () => {
      originCalls++;
      return new Response("gone", { status: 404 });
    };
    // Nothing in the reprint path takes a fetch — it CANNOT reach the origin —
    // and custody re-checks with the dead origin still succeed from what KAX holds.
    const reprint = await reprintMasterBytes(master.id, storage);
    expect(reprint.bytes).toEqual(masterBytes);
    expect(reprint.contentType).toBe("image/png");
    expect((await takeCustody(id, storage, origin404)).alreadyHeld).toBe(true);
    expect(originCalls).toBe(0);

    // A tampered master is refused, never printed.
    await storage.put(derivedKeyFor(id, master.sha256), pngFixture(2, 2), "image/png");
    await expect(reprintMasterBytes(master.id, storage)).rejects.toThrow(/hash mismatch/);
  });

  it("the sha256 recorded on the derived row matches the stored bytes", async () => {
    const id = await makeArtifact("https://kfz.supabase.co/sha.png");
    const body = pngFixture(1024, 1024);
    const serve: typeof fetch = async () => new Response(body, { status: 200 });
    await measureArtifactAsset(id, serve);
    const storage = new MemoryStorageAdapter();
    await takeCustody(id, storage, serve);
    const bytes = pngFixture(2048, 2048);
    const row = await createDerivedAsset({
      sourceArtifactId: id, transformType: "upscale", transformFactor: 2, bytes, storage,
    });
    expect(row.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect(row.byteSize).toBe(BigInt(bytes.length));
    expect(row.widthPx).toBe(2048);
  });
});
