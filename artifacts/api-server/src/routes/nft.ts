import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, nftMintsTable, activitiesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { canMutate, requireAuth, getOwnerScope } from "../middlewares/requireAuth";
import { publicArtifactWhere } from "../lib/visibility";
import { publish as publishConstellation } from "../lib/constellationBridge";

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
  // EVM chainIds are in EIP-155 spec a uint256 on chain but in practice
  // never exceed ~2^31. Cap at JS safe-int / a sane upper bound so a
  // typo doesn't write 9999999999 into the DB.
  if (chainId > 2_147_483_647) {
    return { ok: false, error: "chainId out of range (>2147483647)" };
  }
  const contractAddress = typeof b["contractAddress"] === "string" ? (b["contractAddress"] as string) : "";
  if (!HEX_ADDR.test(contractAddress)) {
    return { ok: false, error: "contractAddress must be 0x + 40 hex" };
  }
  const tokenId = typeof b["tokenId"] === "string" ? (b["tokenId"] as string).trim() : "";
  if (tokenId.length === 0 || tokenId.length > 78) {
    return { ok: false, error: "tokenId must be a non-empty string (<=78 chars)" };
  }
  // tokenId is on-chain a uint256 — must be a decimal integer string.
  // Anything else (e.g. "0xabc", "1e10", "1.5") is the wrong shape and
  // will not match the on-chain token. Previously we accepted any 78-char
  // string, so a "1e10"-shaped typo silently stored garbage and the
  // metadata URI pointed nowhere.
  if (!/^[0-9]+$/.test(tokenId)) {
    return { ok: false, error: "tokenId must be a decimal integer string" };
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

/**
 * Resolve the canonical origin for NFT-side URLs.
 *
 * NFT routes persist the result into nft_mints.metadataUri AND emit it
 * in the public metadata response. Both are durably attached to a token
 * on-chain — once a poisoned origin lands in nft_mints it stays there.
 *
 * To avoid attacker-controlled-Host poisoning (#15) this is now
 * configuration-only: `PUBLIC_BASE_URL` must be set, or we throw on the
 * call. Operators who used to rely on the implicit "use req.host"
 * fallback need to set PUBLIC_BASE_URL to their canonical origin
 * (typically the same value as the SPA serves under). Allowlist
 * mode (multi-tenant) is intentionally deferred — when we need it,
 * extend this helper rather than re-introducing Host trust.
 */
function publicBaseUrl(_req: unknown): string {
  const envBase = (process.env["PUBLIC_BASE_URL"] || "").trim();
  if (!envBase) {
    throw new Error(
      "PUBLIC_BASE_URL must be set for NFT routes — Host-header origins are not trusted (security: #15).",
    );
  }
  return envBase.replace(/\/$/, "");
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
  // The public ERC-721 metadata route may only return artifacts that
  // are (a) publicly visible AND (b) have an actual on-chain mint
  // recorded. Without these filters we leaked unpublished artifact
  // titles, narratives, image URLs, and OBC IDs by enumerable id (#12).
  const [a] = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.id, id), publicArtifactWhere()))
    .limit(1);
  if (!a) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }
  const [mint] = await db
    .select({ id: nftMintsTable.id })
    .from(nftMintsTable)
    .where(eq(nftMintsTable.artifactId, id))
    .limit(1);
  if (!mint) {
    res.status(404).json({ error: "artifact has not been minted" });
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
      // Kannaka Score trait — guard against null, undefined, NaN, and
      // ±Infinity. Previously only `!== null` was checked, so a NaN
      // kannakaScore (which can sneak in if a future computeScore
      // returns NaN from a divide-by-zero) silently shipped a trait
      // with value: NaN that JSON-stringifies to `null` and confuses
      // NFT marketplaces that expect a number.
      ...(typeof a.kannakaScore === "number" && Number.isFinite(a.kannakaScore)
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

    // Outbound — radio + observatory can announce mints. Fire after the
    // DB has the truth; before sending the response so the listener
    // ordering aligns with the user's expectation of "the mint is done".
    await publishConstellation("KAX.events.mint.recorded", {
      artifactId: id,
      title: a.title,
      chainId: parsed.data.chainId,
      contractAddress: parsed.data.contractAddress.toLowerCase(),
      tokenId: parsed.data.tokenId,
      txHash: parsed.data.txHash.toLowerCase(),
      metadataUri,
    });

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
