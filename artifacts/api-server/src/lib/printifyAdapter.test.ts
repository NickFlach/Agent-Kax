/**
 * printifyAdapter.test.ts — the #261 adapter subset added to printifyClient:
 * uploadImageByUrl / createProduct / cancelOrder. Pure (no DB): a local fetch
 * stub records every outbound call, so payload shape and refusal behaviour
 * are asserted against what would actually cross the wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrintifyError,
  getUncachablePrintifyClient,
  type PrintifyClient,
} from "./printifyClient";

const ENV = ["KAX_PRINTIFY_ENABLED", "KAX_PRINTIFY_API_TOKEN", "KAX_PRINTIFY_SHOP_ID"] as const;
const prior = new Map<string, string | undefined>();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}
let outbound: Call[] = [];
let nextResponse = { status: 200, body: "{}" };

function respondWith(status: number, body: unknown): void {
  nextResponse = { status, body: JSON.stringify(body) };
}

function client(): PrintifyClient {
  return getUncachablePrintifyClient();
}

beforeEach(() => {
  for (const k of ENV) prior.set(k, process.env[k]);
  process.env["KAX_PRINTIFY_ENABLED"] = "1";
  process.env["KAX_PRINTIFY_API_TOKEN"] = "test-token";
  process.env["KAX_PRINTIFY_SHOP_ID"] = "28604869";
  outbound = [];
  nextResponse = { status: 200, body: "{}" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: Record<string, unknown> = {}) => {
      outbound.push({
        url: String(input),
        method: String(init["method"] ?? "GET"),
        body: init["body"] ? (JSON.parse(String(init["body"])) as Record<string, unknown>) : {},
      });
      return {
        ok: nextResponse.status < 300,
        status: nextResponse.status,
        text: async () => nextResponse.body,
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  for (const k of ENV) {
    const v = prior.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("uploadImageByUrl (#261)", () => {
  it("posts file_name + url to the media library and returns the id", async () => {
    respondWith(200, { id: "img_123", file_name: "kax-11.png" });
    const ref = await client().uploadImageByUrl("kax-11.png", "https://kfz.supabase.co/a.png");
    expect(ref).toEqual({ id: "img_123", fileName: "kax-11.png" });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.url).toMatch(/\/uploads\/images\.json$/);
    expect(outbound[0]!.body).toEqual({ file_name: "kax-11.png", url: "https://kfz.supabase.co/a.png" });
  });

  it("a 2xx with no id is refused loudly — the upload-ambiguity shape", async () => {
    respondWith(200, {});
    await expect(
      client().uploadImageByUrl("x.png", "https://kfz.supabase.co/x.png"),
    ).rejects.toThrow(PrintifyError);
  });
});

describe("createProduct (#261)", () => {
  it("creates with full-bleed front placement and NEVER publishes", async () => {
    respondWith(200, { id: "prod_9" });
    const ref = await client().createProduct({
      title: "Sticker",
      blueprintId: 476,
      printProviderId: 73,
      variants: [{ id: 65212, priceCents: 399 }],
      imageId: "img_123",
    });
    expect(ref).toEqual({ id: "prod_9" });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.url).toMatch(/\/shops\/28604869\/products\.json$/);
    const body = outbound[0]!.body as {
      blueprint_id: number;
      print_provider_id: number;
      variants: Array<{ id: number; price: number; is_enabled: boolean }>;
      print_areas: Array<{ variant_ids: number[]; placeholders: Array<{ position: string; images: Array<{ id: string; scale: number }> }> }>;
    };
    expect(body.blueprint_id).toBe(476);
    expect(body.print_provider_id).toBe(73);
    expect(body.variants).toEqual([{ id: 65212, price: 399, is_enabled: true }]);
    expect(body.print_areas[0]!.variant_ids).toEqual([65212]);
    expect(body.print_areas[0]!.placeholders[0]!.position).toBe("front");
    expect(body.print_areas[0]!.placeholders[0]!.images[0]).toMatchObject({ id: "img_123", scale: 1 });
    // The publish endpoint is a separate deliberate act: no call to it, ever,
    // from the create path.
    expect(outbound.some((c) => c.url.includes("publish"))).toBe(false);
  });
});

describe("cancelOrder (#261)", () => {
  it("posts to the cancel endpoint and returns the ref", async () => {
    respondWith(200, { id: "ord_5", status: "canceled" });
    const ref = await client().cancelOrder("ord_5");
    expect(ref.id).toBe("ord_5");
    expect(outbound[0]!.url).toMatch(/\/orders\/ord_5\/cancel\.json$/);
    expect(outbound[0]!.method).toBe("POST");
  });
});
