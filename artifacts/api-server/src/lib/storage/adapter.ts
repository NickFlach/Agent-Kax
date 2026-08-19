/**
 * storage/adapter.ts — the storage seam (#264).
 *
 * THE STORAGE DECISION, recorded: KAX object storage is any S3-COMPATIBLE
 * bucket, configured entirely by environment, spoken to by the dependency-free
 * SigV4 client in ./s3.ts. Supabase Storage's S3 gateway is the expected
 * first deployment (the constellation already lives on Supabase), and R2/AWS
 * work unchanged — the commitment is to the PROTOCOL, not a vendor.
 *
 * The adapter is INERT until the operator sets the env (the issue's operator
 * dependency: a storage account and its credentials). Everything that needs
 * custody fails loudly with StorageUnconfigured — the exact 503-when-unset
 * idiom requireCommerceToken proved — never by silently skipping custody.
 */

export interface StorageObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface StorageAdapter {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StorageObject | null>;
}

export class StorageUnconfigured extends Error {
  readonly code = "storage_unconfigured";
  constructor() {
    super(
      "KAX object storage is not configured — set KAX_STORAGE_ENDPOINT, KAX_STORAGE_BUCKET, " +
        "KAX_STORAGE_REGION, KAX_STORAGE_ACCESS_KEY_ID and KAX_STORAGE_SECRET_ACCESS_KEY",
    );
  }
}

/** The five env names, in one place. */
export const STORAGE_ENV_VARS = [
  "KAX_STORAGE_ENDPOINT",
  "KAX_STORAGE_BUCKET",
  "KAX_STORAGE_REGION",
  "KAX_STORAGE_ACCESS_KEY_ID",
  "KAX_STORAGE_SECRET_ACCESS_KEY",
] as const;

export function storageConfigured(): boolean {
  return STORAGE_ENV_VARS.every((v) => !!process.env[v]);
}

/**
 * The production adapter, or a loud refusal. Constructed per call — env is
 * read at use time, not import time, so a Replit secret added without a
 * redeploy takes effect (the requireCommerceToken lesson).
 */
export async function storageFromEnv(): Promise<StorageAdapter> {
  if (!storageConfigured()) throw new StorageUnconfigured();
  const { S3StorageAdapter } = await import("./s3");
  return new S3StorageAdapter({
    endpoint: process.env["KAX_STORAGE_ENDPOINT"]!,
    bucket: process.env["KAX_STORAGE_BUCKET"]!,
    region: process.env["KAX_STORAGE_REGION"]!,
    accessKeyId: process.env["KAX_STORAGE_ACCESS_KEY_ID"]!,
    secretAccessKey: process.env["KAX_STORAGE_SECRET_ACCESS_KEY"]!,
  });
}

/** In-memory adapter for tests: byte-faithful, no I/O. */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, StorageObject>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType });
  }

  async get(key: string): Promise<StorageObject | null> {
    const o = this.objects.get(key);
    return o ? { bytes: new Uint8Array(o.bytes), contentType: o.contentType } : null;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}
