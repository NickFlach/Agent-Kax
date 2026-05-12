# KannakaArtifact NFT contract

ERC-721 contract used to mint **1-of-1 OpenBotCity artifacts** as
on-chain collectibles surfaced by KAX.

- Source: [`src/KannakaArtifact.sol`](./src/KannakaArtifact.sol)
- Tests:  [`test/KannakaArtifact.t.sol`](./test/KannakaArtifact.t.sol) — 33 tests, full pass
- Audit:  [`AUDIT-KannakaArtifact.md`](./AUDIT-KannakaArtifact.md)
- Inherits: `ERC721`, `ERC721URIStorage`, `ERC2981`, `Pausable`, `Ownable2Step`
- Each `artifactUuid` can only be minted **once** per contract instance.

## Features

- **Ownable2Step** — two-step ownership transfer; a fat-fingered
  `transferOwnership` can't brick minting.
- **ERC-2981 royalties** — default royalty + per-token override,
  configurable at deploy or via owner setters.
- **Pausable mint** — emergency stop. Transfers still work; collectors
  keep full custody of their tokens while the contract is paused.
- **Atomic batch mint** — `mintArtifactBatch` mints up to 64 tokens
  per tx; any single failure reverts the whole batch.
- **EIP-4906** — `supportsInterface(0x49064906)` so marketplaces refresh
  metadata. OpenZeppelin v5's `_setTokenURI` already emits the
  `MetadataUpdate` event for free.
- **Reentrancy-safe** — mapping writes happen BEFORE `_safeMint`, so a
  malicious `IERC721Receiver` cannot double-mint the same UUID during
  its `onERC721Received` callback.
- **Input validation** — non-empty UUID with a 64-byte cap (OBC UUIDs
  are 36 chars), non-empty URI with a 512-byte cap.

## Metadata source

KAX hosts per-token metadata at:

```
https://<your-kax-domain>/api/nft/metadata/<artifactId>.json
```

The JSON conforms to the standard ERC-721 metadata schema (`name`,
`description`, `image`, `external_url`, `attributes`). For long-term
permanence, prefer `ipfs://` URIs once the artifact image and JSON are
pinned — KAX shutdown shouldn't break the collectible.

## Build, test, deploy (Foundry)

This directory is a self-contained Foundry project. Dependencies are
tracked as git submodules under `contracts/lib/` and pinned in
`foundry.lock` (OpenZeppelin v5.1.0, forge-std v1.16.1). From the repo
root:

```bash
git submodule update --init --recursive   # one-time after a fresh clone
cd contracts
forge build
forge test -vv
```

> If you bumped a submodule and `forge` complains about a mismatch,
> regenerate `foundry.lock` with `forge install` (no args).

Deploy (set env vars first):

```bash
export PRIVATE_KEY=0x...
export RPC_URL=https://...        # e.g. Base, Optimism, Arbitrum, Sepolia
export OWNER=0xYourAddress
export ROYALTY_RECEIVER=0x...     # or 0x0000000000000000000000000000000000000000 to skip
export ROYALTY_BPS=500            # 500 = 5%, max 10_000

forge create src/KannakaArtifact.sol:KannakaArtifact \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args $OWNER $ROYALTY_RECEIVER $ROYALTY_BPS
```

## Mint a 1-of-1

```solidity
mintArtifact(
    0xCollectorAddress,
    "4623809f-7960-4ed3-aa6e-c9456afd03a7",     // artifact UUID from KAX
    "ipfs://bafyXXX"                            // metadata CID (preferred) or KAX URL
);
```

Then record the mint back in KAX so the storefront shows the chain
data:

```bash
curl -X POST https://<your-kax-domain>/api/artifacts/123/mint \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <your session cookie>' \
  -d '{
    "chainId": 8453,
    "contractAddress": "0xCONTRACT",
    "tokenId": "1",
    "txHash": "0xTXHASH",
    "mintedToAddress": "0xCOLLECTOR"
  }'
```

## Test coverage

`test/KannakaArtifact.t.sol` — 31 tests, all passing on Solc 0.8.24 + OZ v5.1.0:

| Area | Tests |
| --- | --- |
| Happy path | first mint, two-UUID independence, `ArtifactMinted` event |
| Access control | non-owner blocked; Ownable2Step propose/accept; wrong acceptor blocked |
| Input validation | empty UUID, empty URI, URI > 512 bytes, already-minted UUID |
| Reentrancy | malicious `IERC721Receiver` re-entering with same UUID hits `AlreadyMinted` |
| ERC-2981 royalties | constructor default, scaling with price, owner updates/delete, per-token override, reset, non-owner blocked, deploy without royalty |
| Pausable | pause blocks mint, unpause restores, transfers unaffected by pause, non-owner blocked |
| Batch mint | three-atomic mint, any duplicate reverts batch, empty batch, length mismatch, oversize batch, paused blocks batch |
| Interface support | ERC-165, ERC-721, ERC-721 Metadata, ERC-4906, ERC-2981 |
| Fuzz | `nextTokenId` matches mint count across 256 runs |
