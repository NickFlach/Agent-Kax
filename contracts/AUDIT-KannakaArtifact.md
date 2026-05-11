# Smart Contract Audit — `KannakaArtifact.sol`

**Auditor:** internal review (claude-flow)
**Date:** 2026-05-11
**Commit:** `0c0e567` (`contracts/KannakaArtifact.sol`, 88 LOC)
**Scope:** the single contract file. OpenZeppelin v5 dependencies are out-of-scope (audited upstream).
**Methodology:** manual review, Solidity 0.8.24 semantics, OZ v5 ERC-721 / ERC-721URIStorage / Ownable inheritance chain, EIP-721 / EIP-165 / EIP-2981 compliance check, gas-cost review.

---

## Executive Summary

Eighty-eight lines of focused, owner-only 1-of-1 ERC-721 with an `artifactUuid → tokenId` invariant. No critical issues. **Two High-severity findings** concerning ownership single-point-of-failure (H-1) and unconstrained metadata URIs (H-2). **Four Medium** findings around invariant fragility, calldata bounds, deployment observability, and event design. **Four Low / four Informational / three Gas** findings rounding it out. **No test suite present**, which is itself the most significant gap before a mainnet deploy.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 4 |
| Low | 4 |
| Informational | 4 |
| Gas | 3 |

---

## High Findings

### H-1 — Owner key is the entire admin surface; no two-step transfer; no role separation

**Location:** `Ownable` import (line 6), constructor (lines 39-42), `mintArtifact` (`onlyOwner` modifier, line 52)

**Description.** The contract uses OpenZeppelin's `Ownable` and gates `mintArtifact` on `onlyOwner`. The deployer's address becomes the sole authority for every mint forever. Ownable's `transferOwnership(newOwner)` takes effect in a single transaction with no acknowledgement from the recipient — a typo to an unrecoverable address bricks all future mints. `renounceOwnership()` is callable and immediately permanent. There is no separation between "mint" authority (operational) and "admin" authority (rotational).

**Impact.**
- Compromise of the single owner key → attacker can mint arbitrary artifact UUIDs with arbitrary metadata URIs, indistinguishable on-chain from legitimate KAX mints.
- Loss of the single owner key → no future mints possible, no recovery, no admin operations.
- Typo on `transferOwnership` → same as loss.

**Recommendation.** Two options, pick one:

1. **`Ownable2Step`** (minimal change). Replace the `Ownable` import with `@openzeppelin/contracts/access/Ownable2Step.sol`. `transferOwnership(newOwner)` becomes a pending state; the new owner must call `acceptOwnership()` to take control. Prevents typos and gives an audit window for compromised handoffs.

2. **`AccessControl` with `MINTER_ROLE` + `DEFAULT_ADMIN_ROLE`** (preferred for production). Day-to-day mint authority is the rotatable `MINTER_ROLE` (held by a hot KAX server key). Admin authority is the cold `DEFAULT_ADMIN_ROLE` (held by a multi-sig or hardware wallet) and only revokes/grants roles. If the hot key is compromised, the cold key revokes it without losing the contract.

Either option is a 5-line change.

---

### H-2 — Per-token URI is unconstrained; metadata integrity is fully off-chain

**Location:** line 58, `_setTokenURI(tokenId, uri)`

**Description.** `mintArtifact` accepts an arbitrary `uri` string from the (owner) caller and stores it in `ERC721URIStorage`'s mapping. The URI is opaque — no validation that it points at a KAX-controlled domain, no content hash, no expiry handling.

Implications:
- If the owner key is compromised (see H-1), the attacker can mint with deceptive metadata URLs that load attacker-controlled JSON.
- Even with no compromise: if the KAX metadata domain ever expires, fails to renew, or is rebranded, every existing token's `tokenURI()` silently 404s. The on-chain record points at nothing recoverable.
- The metadata image, traits, description — all marketplace-visible fields — depend on a single off-chain server reachable now.

**Impact.** NFT's "permanence" promise is weaker than buyers typically assume. A KAX disappearance event = collection-level metadata loss.

**Recommendation.** Two complementary mitigations:

1. **Constrain the URI base.** Add a `string public metadataBaseURI` deploy-time constant; `mintArtifact` accepts only a relative path or just a tokenId, and `tokenURI` builds the full URL by concatenation. Owner cannot supply arbitrary domains. Saves gas too (see I-2).

2. **Store an immutable content hash per token.** Add a parallel `mapping(uint256 => bytes32) public metadataHash` and an `ipfs://` URI scheme. If the KAX domain dies, the metadata can be reconstructed from IPFS by any holder using the on-chain hash. Marketplaces that support `ipfs://` resolve it natively.

Combined: store an IPFS CID for the immutable copy, and the KAX URL as the human-pretty serving path. Both reachable, neither single-point-of-failure.

---

## Medium Findings

### M-1 — Implicit invariant: "not minted" detected via `tokenIdForArtifact[uuid] == 0`

**Location:** line 54, `require(tokenIdForArtifact[artifactUuid] == 0, "already minted")`

**Description.** The double-mint guard relies on the fact that `_nextTokenId` starts at 1 (line 27), making `0` an unreachable tokenId that can serve as the "no token" sentinel. This works as written, but is an implicit cross-line invariant. A future maintainer changing `_nextTokenId = 1` to `_nextTokenId = 0` (or starting from a migration that imports a token with id 0) silently breaks the guard — `tokenIdForArtifact[X] == 0` would then incorrectly report "not minted" for the artifact mapped to tokenId 0.

**Impact.** Latent. No exploit today; high risk of a regression on future modification.

**Recommendation.** Replace the sentinel with an explicit boolean:

```solidity
mapping(string => bool)    public mintedArtifact;
mapping(string => uint256) public tokenIdForArtifact;
// ...
require(!mintedArtifact[artifactUuid], "already minted");
mintedArtifact[artifactUuid] = true;
tokenIdForArtifact[artifactUuid] = tokenId;
```

Costs ~22k extra gas on first-write per UUID (one additional SSTORE), but removes the invariant footgun.

---

### M-2 — `_setTokenURI` URI length is unbounded; calldata grief surface

**Location:** line 51, `string calldata uri`

**Description.** `uri` is unbounded. The owner is the only caller, so this is bounded by owner behavior — but a misconfigured front-end pushing a multi-kilobyte URI per mint inflates both calldata gas and the storage write inside `_setTokenURI` (URIStorage stores the full string). Similarly `artifactUuid` (line 50) is unbounded; OBC UUIDs are 36 ASCII chars, so anything beyond ~64 chars is wrong.

**Impact.** Gas griefing if a buggy KAX backend passes huge strings. Not a security boundary issue.

**Recommendation.**
```solidity
require(bytes(artifactUuid).length <= 64, "artifactUuid too long");
require(bytes(uri).length <= 512, "uri too long");
```

512 chars is generous for a `https://kax.../api/nft/metadata/<digits>.json` URL or an `ipfs://Qm...` reference.

---

### M-3 — Mapping write occurs AFTER `_safeMint`; ordering is fragile

**Location:** lines 57-59:
```solidity
_safeMint(to, tokenId);
_setTokenURI(tokenId, uri);
tokenIdForArtifact[artifactUuid] = tokenId;
```

**Description.** The mapping write is the last step. In Solidity all three operations are atomic — if any reverts, the entire tx reverts and no state changes. But the *reading order* makes it look like there could be a window where the token exists but the mapping doesn't. A future maintainer might inline a try/catch around `_setTokenURI` or split the function, breaking the atomicity guarantee that currently saves this ordering.

**Impact.** No bug today (atomic revert); fragile under refactor.

**Recommendation.** Reorder so all critical state mutations happen before any external call:

```solidity
tokenIdForArtifact[artifactUuid] = tokenId;
_safeMint(to, tokenId);          // potential external call to onERC721Received
_setTokenURI(tokenId, uri);
emit ArtifactMinted(...);
```

`_safeMint` calls `onERC721Received` on contract receivers — that's a real external call, so this is also a **Checks-Effects-Interactions** improvement in addition to readability.

---

### M-4 — No `MetadataUpdate` event on `_setTokenURI`

**Location:** line 58

**Description.** EIP-4906 (`ERC721 Metadata Update`) defines a `MetadataUpdate(uint256 tokenId)` and `BatchMetadataUpdate(...)` event so marketplaces know when to re-fetch metadata. OZ v5's `ERC721URIStorage._setTokenURI` does NOT emit this event automatically (it's an opt-in extension). Marketplaces like OpenSea rely on it to refresh cached metadata.

**Impact.** Marketplaces will cache the first metadata fetch potentially forever. If KAX needs to update an artifact's image or fix a typo in the description (the metadata server returns new JSON), marketplaces won't see it without a manual cache-bust request.

**Recommendation.** Implement the EIP-4906 extension. After `_setTokenURI(...)`:

```solidity
emit MetadataUpdate(tokenId);
```

And declare the interface support in `supportsInterface`:

```solidity
if (interfaceId == 0x49064906) return true;  // EIP-4906
```

---

## Low Findings

### L-1 — No EIP-2981 royalty information

**Location:** Contract-wide

**Description.** Without EIP-2981, secondary-market sales on OpenSea / LooksRare / Blur don't enforce any royalty back to the artist. Even on royalty-honoring marketplaces, the default is 0%.

**Impact.** Lost artist revenue on every secondary sale.

**Recommendation.** Inherit `ERC2981` from OZ and set per-token or default royalty:

```solidity
import "@openzeppelin/contracts/token/common/ERC2981.sol";
// ...
constructor(address initialOwner, address royaltyReceiver, uint96 royaltyBps)
  ERC721("Kannaka Artifact", "KAX") Ownable2Step(initialOwner)
{
  _setDefaultRoyalty(royaltyReceiver, royaltyBps);  // e.g., 500 = 5%
}
```

Also extend `supportsInterface` to advertise EIP-2981.

---

### L-2 — No pause mechanism

**Location:** Contract-wide

**Description.** If a bug or operational issue surfaces post-deploy, there's no way to halt minting while a fix is developed. The contract is immutable, so the only recourse would be `renounceOwnership()` (drastic) or social coordination (slow).

**Impact.** Loss of operational flexibility. Acceptable if the design philosophy is "true immutability"; problematic if you might need to pause for a metadata host outage or a discovered front-running issue (e.g., M-3 evolves).

**Recommendation.** Optional. Inherit `Pausable`, add `whenNotPaused` to `mintArtifact`, expose owner-only `pause()` / `unpause()`. Introduces another centralization point — make the choice consciously.

---

### L-3 — No batch mint

**Location:** `mintArtifact`

**Description.** KAX harvests artifacts continuously; minting one-by-one is gas-expensive at scale. Each mint incurs ~80-120k gas of base + storage overhead.

**Recommendation.** Add a batch entry point amortizing the per-call overhead:

```solidity
function mintArtifactBatch(
    address[] calldata tos,
    string[] calldata artifactUuids,
    string[] calldata uris
) external onlyOwner returns (uint256[] memory ids) {
    require(tos.length == artifactUuids.length && tos.length == uris.length, "length mismatch");
    ids = new uint256[](tos.length);
    for (uint256 i = 0; i < tos.length; ++i) {
        ids[i] = mintArtifact(tos[i], artifactUuids[i], uris[i]);  // make mintArtifact internal-callable
    }
}
```

(Refactor `mintArtifact` to delegate to an `_mintArtifact` internal helper so the loop body doesn't re-do `onlyOwner` per iteration.)

---

### L-4 — `nextTokenId()` is racy under concurrent owner actions; docstring missing

**Location:** line 65

**Description.** Owner calls `nextTokenId()` to predict the next id, then calls `mintArtifact`. Another `mintArtifact` submitted in parallel can land first, moving the predicted id. Not a real exploit (owner-only), but every external user of this view function should know the prediction is best-effort.

**Recommendation.** Docstring:

```solidity
/// @notice The id the next mint *would* return if called immediately after.
///         Not a reservation — concurrent mints invalidate the prediction.
///         The authoritative tokenId is the return value of `mintArtifact`.
function nextTokenId() external view returns (uint256) { ... }
```

---

## Informational

### I-1 — Pragma is `^0.8.24`; pin for production reproducibility

`^0.8.24` allows the compiler to drift across minor versions across deploys. For reproducible builds and bytecode determinism, drop the caret: `pragma solidity 0.8.24;` and pin the compiler in `hardhat.config` / `foundry.toml`.

### I-2 — `ERC721URIStorage` is heavier than a baseURI pattern

If every artifact's metadata URL is `<base>/api/nft/metadata/<tokenId>.json`, the contract could store nothing per-token and just override `_baseURI()`. Saves ~20k gas per mint vs URIStorage. Trade-off: lose per-token URI flexibility. Reasonable to keep URIStorage given H-2's IPFS-hash recommendation also benefits from per-token storage.

### I-3 — Consider `Deployed` event in constructor

Marketplaces and indexers backfill state by scanning logs. The first event a fresh contract emits is `OwnershipTransferred(0, initialOwner)` from OZ's Ownable — useable but indirect. A dedicated `event Deployed(address initialOwner, string name, string symbol)` is clearer for indexer authors and is one line of constructor code.

### I-4 — Verify on Etherscan / chain explorer

Not in the contract itself, but: ensure the deploy script verifies source on Etherscan (and Sourcify for chain redundancy). Unverified contracts on a public mainnet are a major buyer trust signal.

---

## Gas Optimizations

### G-1 — Wrap `_nextTokenId++` in `unchecked`

Saves ~80 gas per mint. The increment cannot realistically overflow `2^256 - 1`:

```solidity
uint256 tokenId;
unchecked { tokenId = _nextTokenId++; }
```

### G-2 — Replace revert strings with custom errors

```solidity
error ArtifactUuidRequired();
error AlreadyMinted();
error ArtifactUuidTooLong();
error UriTooLong();

if (bytes(artifactUuid).length == 0) revert ArtifactUuidRequired();
if (tokenIdForArtifact[artifactUuid] != 0) revert AlreadyMinted();
```

Saves ~50 gas on failed calls, reduces deployed bytecode by ~200 bytes.

### G-3 — Make `tokenIdForArtifact`'s key type a `bytes32` instead of `string` when UUID is fixed-length

OBC artifact UUIDs are 36 hex chars (128-bit UUIDs as 32-hex with dashes). Storing them as `string` allocates a dynamic-length record + costs O(length) per hash. Pre-hashing to `bytes32` at the API layer and storing `mapping(bytes32 => uint256)` saves ~5k gas per first-mint write and ~2k per read.

Trade-off: the on-chain artifact UUID is no longer human-readable in storage explorers; the event still emits the string for indexer-friendly logs.

---

## Test Coverage Review

**None found.** `contracts/` contains only the .sol file. No Hardhat or Foundry config, no test directory, no `package.json` for the contracts subpackage.

**Before a mainnet deploy, recommended test surface:**

| Test | Why |
|---|---|
| Owner-only mint | guards H-1 |
| Same-UUID double-mint reverts | guards M-1 |
| Empty UUID reverts | guards `require` at line 53 |
| `_safeMint` to a contract that rejects (returns wrong selector) reverts | confirms ERC-721 compliance |
| `_safeMint` to a contract that accepts | confirms positive path |
| `transferOwnership` two-step (after H-1 fix) | confirms accept-step |
| Renounce ownership leaves mints frozen | confirms expected behavior |
| `tokenURI` returns the stored value | regression for URIStorage |
| `supportsInterface` returns true for ERC-721, ERC-721Metadata, ERC-165 | EIP-165 compliance |
| `ArtifactMinted` event shape | indexers depend on this |
| Royalty info (after L-1 fix) returns expected receiver + bps | EIP-2981 compliance |
| Gas snapshot for `mintArtifact` | regression guardrail |

Use Foundry's `forge test --gas-report` for the gas snapshot. Aim for ≥90% line coverage.

---

## Remediation Priority

### One afternoon (recommended pre-deploy)
1. **H-1** — Switch `Ownable` → `Ownable2Step`. Five-line change.
2. **M-1** — Add explicit `mintedArtifact` boolean. Removes implicit invariant.
3. **M-3** — Reorder mapping write before `_safeMint`. Checks-Effects-Interactions.
4. **M-4** — Emit `MetadataUpdate(tokenId)` per EIP-4906.
5. Add a minimal Foundry test suite covering the items above.

### One week (recommended pre-mainnet)
6. **H-2** — Add an immutable `metadataBaseURI` + optional per-token IPFS hash for content integrity.
7. **L-1** — Add ERC-2981 royalty info; pick a default rate (e.g., 5%) and a treasury wallet.
8. **L-3** — Add batch mint.
9. **G-1, G-2, G-3** — Gas optimizations.
10. Full Foundry test suite with ≥90% line coverage and a gas snapshot baseline.

### Optional
- **L-2** — Pause mechanism. Adds centralization; only if you might need it.
- **I-3** — Deployed event.
- **I-4** — Etherscan + Sourcify verification on deploy.

---

## Conclusion

The contract is small, focused, and built on well-audited OpenZeppelin v5 primitives. There are no critical issues and no immediate exploit paths against the current owner-only minting model. The two High findings are about the **operational** and **integrity** surfaces — the owner key being a single point of failure (H-1), and the metadata URI being fully off-chain (H-2). Both are addressable with under an hour of work each.

The biggest gap is the **absence of a test suite**. For a 1-of-1 collectible contract that will hold artist work permanently, this is the single most important thing to add before any mainnet deploy.

If you want me to ship the recommended fixes as a follow-up commit (or just the "one afternoon" tier), say the word.
