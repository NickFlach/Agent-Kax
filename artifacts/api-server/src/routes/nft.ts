import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, nftMintsTable, activitiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { canMutate, requireAuth, getOwnerScope } from "../middlewares/requireAuth";

const router: IRouter = Router();

const HEX_ADDR = /^0x[a-fA-F0-9]{40}$/u;
const HEX_TX = /^0x[a-fA-F0-9]{64}$/u;

interface RecordMintInput {
  chainId: number;
  contractAddress: string;
  tokenId: string;
  txHash: string;
  mintedToAddress: string;
}

function parseRecordMintBody(body: unknown): { ok: true; data: RecordMintInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const chainId = typeof b["chainId"] === "number" ? (b["chainId"] as number) : NaN;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { ok: false, error: "chainId must be a positive integer" };
  }
  const contractAddress = typeof b["contractAddress"] === "string" ? (b["contractAddress"] as string) : "";
  if (!HEX_ADDR.test(contractAddress)) {
    return { ok: false, error: "contractAddress must be 0x + 40 hex" };
  }
  const tokenId = typeof b["tokenId"] === "string" ? (b["tokenId"] as string).trim() : "";
  if (tokenId.length === 0 || tokenId.length > 78) {
    return { ok: false, error: "tokenId must be a non-empty string (<=78 chars)" };
  }
  const txHash = typeof b["txHash"] === "string" ? (b["txHash"] as string) : "";
  if (!HEX_TX.test(txHash)) {
    return { ok: false, error: "txHash must be 0x + 64 hex" };
  }
  const mintedToAddress = typeof b["mintedToAddress"] === "string" ? (b["mintedToAddress"] as string) : "";
  if (!HEX_ADDR.test(mintedToAddress)) {
    return { ok: false, error: "mintedToAddress must be 0x + 40 hex" };
  }
  return { ok: true, data: { chainId, contractAddress, tokenId, txHash, mintedToAddress } };
}

function publicBaseUrl(req: { protocol: string; get: (h: string) => string | undefined }): string {
  const envBase = process.env["PUBLIC_BASE_URL"];
  if (envBase && envBase.length > 0) return envBase.replace(/\/$/, "");
  const host = req.get("host") ?? "localhost";
  return `${req.protocol}://${host}`;
}

/**
 * Public ERC-721 metadata endpoint. Marketplaces (OpenSea, etc.) and
 * the on-chain `tokenURI` resolve to this URL.
 */
router.get("/nft/metadata/:artifactId.json", async (req, res) => {
  const id = Number(req.params.artifactId);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid artifactId" });
    return;
  }
  const [a] = await db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.id, id))
    .limit(1);
  if (!a) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }
  const base = publicBaseUrl(req);
  res.json({
    name: a.narrativeTitle ?? a.title,
    description: a.narrative ?? `1-of-1 OpenBotCity artifact "${a.title}" by ${a.creatorName}, curated by KAX.`,
    image: a.publicUrl,
    external_url: `${base}/artifacts/${a.id}`,
    attributes: [
      { trait_type: "Creator", value: a.creatorName },
      { trait_type: "Edition", value: a.editionType },
      { trait_type: "Type", value: a.artifactType },
      { trait_type: "OpenBotCity UUID", value: a.obcArtifactUuid ?? a.externalId },
      ...(a.kannakaScore !== null
        ? [{ trait_type: "Kannaka Score", value: Math.round(a.kannakaScore * 100), display_type: "number" as const }]
        : []),
      ...(a.transmissionId
        ? [{ trait_type: "Transmission", value: a.transmissionId }]
        : []),
    ],
  });
});

/** Get the recorded on-chain mint for an artifact, if any. */
router.get("/artifacts/:id/mint", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);
  if (!a) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }
  const ownerScope = await getOwnerScope(req);
  if (ownerScope !== null && a.ownerId !== ownerScope) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const [mint] = await db
    .select()
    .from(nftMintsTable)
    .where(eq(nftMintsTable.artifactId, id))
    .limit(1);

  const base = publicBaseUrl(req);
  res.json({
    artifactId: id,
    editionType: a.editionType,
    metadataUri: `${base}/api/nft/metadata/${id}.json`,
    mint: mint ?? null,
  });
});

/**
 * Record a mint. The user (or their wallet) deploys the
 * KannakaArtifact contract themselves, calls `mintArtifact(...)`, then
 * POSTs the resulting tx hash + tokenId back here so the storefront
 * surfaces the chain data.
 */
router.post("/artifacts/:id/mint", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const parsed = parseRecordMintBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);
  if (!a) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }
  if (a.editionType !== "1_of_1") {
    res.status(409).json({ error: "only 1_of_1 artifacts can be minted as NFTs" });
    return;
  }
  if (!(await canMutate(req, a.ownerId))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const base = publicBaseUrl(req);
  const metadataUri = `${base}/api/nft/metadata/${id}.json`;

  try {
    const inserted = await db
      .insert(nftMintsTable)
      .values({
        artifactId: id,
        chainId: parsed.data.chainId,
        contractAddress: parsed.data.contractAddress.toLowerCase(),
        tokenId: parsed.data.tokenId,
        txHash: parsed.data.txHash.toLowerCase(),
        mintedToAddress: parsed.data.mintedToAddress.toLowerCase(),
        metadataUri,
      })
      .returning();

    if (a.ownerId) {
      await db.insert(activitiesTable).values({
        type: "harvested",
        message: `NFT mint recorded for "${a.title}" (chain ${parsed.data.chainId}, token #${parsed.data.tokenId})`,
        artifactTitle: a.title,
        ownerId: a.ownerId,
        agentId: a.agentId ?? null,
      });
    }

    res.status(201).json({
      artifactId: id,
      editionType: a.editionType,
      metadataUri,
      mint: inserted[0],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("nft_mints_artifact_id_unique") || message.includes("duplicate key")) {
      res.status(409).json({ error: "this artifact has already been minted" });
      return;
    }
    req.log.error({ err }, "Failed to record NFT mint");
    res.status(500).json({ error: "failed to record mint" });
  }
});

export default router;
