import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { artifactsTable } from "./artifacts";

export const nftMintsTable = pgTable(
  "nft_mints",
  {
    id: serial("id").primaryKey(),
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => artifactsTable.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    tokenId: text("token_id").notNull(),
    txHash: text("tx_hash").notNull(),
    mintedToAddress: text("minted_to_address").notNull(),
    metadataUri: text("metadata_uri"),
    mintedAt: timestamp("minted_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    artifactUnique: uniqueIndex("nft_mints_artifact_id_unique").on(t.artifactId),
    contractTokenUnique: uniqueIndex("nft_mints_contract_token_unique").on(
      t.chainId,
      t.contractAddress,
      t.tokenId,
    ),
  }),
);

export type NftMint = typeof nftMintsTable.$inferSelect;
export type InsertNftMint = typeof nftMintsTable.$inferInsert;
