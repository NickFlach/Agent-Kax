# KannakaArtifact NFT contract

Minimal ERC-721 contract used to mint **1-of-1 OpenBotCity artifacts** as
on-chain collectibles surfaced by KAX.

- File: [`KannakaArtifact.sol`](./KannakaArtifact.sol)
- Standard: ERC-721 + `ERC721URIStorage` (per-token metadata URI)
- Constructor: `constructor(address initialOwner)`
- Mint function (owner-only):
  `mintArtifact(address to, string artifactUuid, string uri) -> uint256 tokenId`
- Each `artifactUuid` can only be minted **once** per contract instance.

## Metadata source

KAX hosts the per-token metadata at:

```
https://<your-kax-domain>/api/nft/metadata/<artifactId>.json
```

Pass that URL as the `uri` argument when minting. The JSON conforms to
the standard ERC-721 metadata schema (`name`, `description`, `image`,
`external_url`, `attributes`).

## Build, test, deploy (Foundry)

This directory is a self-contained Foundry project. From the repo root:

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std --no-commit
forge build
forge test -vvv
```

Deploy (set env vars first):

```bash
export PRIVATE_KEY=0x...
export RPC_URL=https://...      # e.g. Base, Optimism, Arbitrum, Sepolia
export OWNER=0xYourAddress

forge create KannakaArtifact.sol:KannakaArtifact \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args $OWNER
```

The test suite in `test/KannakaArtifact.t.sol` covers happy-path mint,
Ownable2Step propose/accept (and reverts on non-owner mint / wrong
acceptor), input validation, `AlreadyMinted` re-mint guard,
`supportsInterface` for ERC-165 / ERC-721 / ERC-721 Metadata / ERC-4906,
and a reentrancy regression where an `IERC721Receiver` tries to
re-enter `mintArtifact` with the same UUID during its `_safeMint`
callback (must revert with `AlreadyMinted`).

## Deploy quickstart (Hardhat)

```bash
mkdir kax-nft && cd kax-nft
npm init -y
npm i --save-dev hardhat @nomicfoundation/hardhat-toolbox
npm i @openzeppelin/contracts
npx hardhat init   # choose "Create an empty hardhat.config.js"
mkdir contracts && cp ../KannakaArtifact.sol contracts/

cat > scripts/deploy.js <<'EOF'
const hre = require("hardhat");
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const f = await hre.ethers.getContractFactory("KannakaArtifact");
  const c = await f.deploy(deployer.address);
  await c.waitForDeployment();
  console.log("KannakaArtifact deployed to:", await c.getAddress());
}
main().catch((e) => { console.error(e); process.exit(1); });
EOF

npx hardhat compile
npx hardhat run scripts/deploy.js --network <your-network>
```

## Mint a 1-of-1

```solidity
mintArtifact(
    0xCollectorAddress,
    "4623809f-7960-4ed3-aa6e-c9456afd03a7",     // artifact UUID from KAX
    "https://kax.example.com/api/nft/metadata/123.json"
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
