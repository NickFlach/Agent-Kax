// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * KannakaArtifact
 * ----------------
 * 1-of-1 ERC-721 collectible contract for the KAX storefront.
 *
 * Each token corresponds to a single OpenBotCity artifact UUID. The
 * `mintedArtifact` mapping is the source of truth for "has this UUID
 * been minted"; `tokenIdForArtifact` is the lookup for the resulting
 * tokenId. Both are written before `_safeMint` so an ERC-721 receiver
 * cannot re-enter and observe pre-mint state.
 *
 * Features:
 *   - Ownable2Step ownership (propose + accept; no accidental brick).
 *   - ERC-2981 royalties (default + per-token; configurable by owner).
 *   - Pausable mint (emergency stop without blocking transfers).
 *   - Batch mint, atomic — any failure reverts the whole batch.
 *   - URI validation: non-empty + 512-byte cap (mistakes & griefing).
 *   - EIP-4906 metadata-update signalling (supportsInterface bit).
 */
contract KannakaArtifact is ERC721, ERC721URIStorage, ERC2981, Pausable, Ownable2Step {
    /// EIP-4906 interface id, per the spec.
    bytes4 private constant _INTERFACE_ID_ERC4906 = 0x49064906;

    /// Hard cap on per-token URI length. Generous enough for an
    /// ipfs:// CIDv1 plus a path suffix; tight enough to make
    /// pathological calldata unattractive.
    uint256 public constant MAX_URI_BYTES = 512;

    /// Hard cap on batch size. Protects against a single tx running
    /// out of gas mid-mint; pick the next batch up the next block.
    uint256 public constant MAX_BATCH_SIZE = 64;

    uint256 private _nextTokenId = 1;

    /// OpenBotCity artifact UUID -> on-chain tokenId.
    mapping(string => uint256) public tokenIdForArtifact;

    /// Explicit "has this UUID been minted" gate. Replaces the implicit
    /// `tokenId == 0` sentinel so the invariant doesn't break the day
    /// someone changes `_nextTokenId`'s initial value or adds a burn.
    mapping(string => bool) public mintedArtifact;

    event ArtifactMinted(
        uint256 indexed tokenId,
        address indexed to,
        string artifactUuid,
        string tokenURI
    );

    error EmptyArtifactUuid();
    error AlreadyMinted(string artifactUuid);
    error EmptyUri();
    error UriTooLong(uint256 length, uint256 max);
    error EmptyBatch();
    error BatchTooLarge(uint256 length, uint256 max);
    error BatchLengthMismatch(uint256 recipients, uint256 uuids, uint256 uris);

    /**
     * @param initialOwner     Address that receives ownership at deploy.
     * @param royaltyReceiver  Address that receives ERC-2981 royalty
     *                         payments. Pass `address(0)` to skip
     *                         setting a default royalty (you can still
     *                         set per-token royalties later).
     * @param royaltyFeeBps    Default royalty, in basis points
     *                         (10_000 = 100%). Capped at 10_000 by
     *                         OpenZeppelin; common values: 500 (5%),
     *                         1000 (10%).
     */
    constructor(
        address initialOwner,
        address royaltyReceiver,
        uint96 royaltyFeeBps
    )
        ERC721("Kannaka Artifact", "KAX")
        Ownable(initialOwner)
    {
        if (royaltyReceiver != address(0)) {
            _setDefaultRoyalty(royaltyReceiver, royaltyFeeBps);
        }
    }

    /**
     * Mint a 1-of-1 token for an OpenBotCity artifact UUID.
     * Reverts if the UUID was already minted, inputs are invalid,
     * or mints are currently paused.
     */
    function mintArtifact(
        address to,
        string calldata artifactUuid,
        string calldata uri
    ) external onlyOwner whenNotPaused returns (uint256) {
        return _mintArtifact(to, artifactUuid, uri);
    }

    /**
     * Mint many 1-of-1 tokens atomically. If ANY single mint reverts
     * (duplicate UUID, bad URI, recipient rejects the ERC-721 callback,
     * etc.) the whole batch reverts and no state is changed.
     */
    function mintArtifactBatch(
        address[] calldata recipients,
        string[] calldata artifactUuids,
        string[] calldata uris
    ) external onlyOwner whenNotPaused returns (uint256[] memory tokenIds) {
        uint256 n = recipients.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH_SIZE) revert BatchTooLarge(n, MAX_BATCH_SIZE);
        if (artifactUuids.length != n || uris.length != n) {
            revert BatchLengthMismatch(n, artifactUuids.length, uris.length);
        }
        tokenIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            tokenIds[i] = _mintArtifact(recipients[i], artifactUuids[i], uris[i]);
        }
    }

    function _mintArtifact(
        address to,
        string calldata artifactUuid,
        string calldata uri
    ) internal returns (uint256) {
        if (bytes(artifactUuid).length == 0) revert EmptyArtifactUuid();
        if (mintedArtifact[artifactUuid]) revert AlreadyMinted(artifactUuid);

        uint256 uriLen = bytes(uri).length;
        if (uriLen == 0) revert EmptyUri();
        if (uriLen > MAX_URI_BYTES) revert UriTooLong(uriLen, MAX_URI_BYTES);

        uint256 tokenId = _nextTokenId++;

        // Effects BEFORE the `_safeMint` interaction. `_safeMint` calls
        // `onERC721Received` on `to` when it's a contract — a malicious
        // receiver that tried to re-enter with the same UUID will hit
        // `AlreadyMinted` because the gate is already set.
        mintedArtifact[artifactUuid] = true;
        tokenIdForArtifact[artifactUuid] = tokenId;
        _setTokenURI(tokenId, uri);

        _safeMint(to, tokenId);

        emit ArtifactMinted(tokenId, to, artifactUuid, uri);
        return tokenId;
    }

    // --- royalty admin (ERC-2981) ---

    /// Owner updates the contract-wide royalty default.
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    /// Owner removes the contract-wide royalty default.
    function deleteDefaultRoyalty() external onlyOwner {
        _deleteDefaultRoyalty();
    }

    /// Owner sets a per-token royalty that overrides the default.
    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 feeNumerator) external onlyOwner {
        _setTokenRoyalty(tokenId, receiver, feeNumerator);
    }

    /// Owner clears a per-token royalty (falls back to the default).
    function resetTokenRoyalty(uint256 tokenId) external onlyOwner {
        _resetTokenRoyalty(tokenId);
    }

    // --- pause admin ---

    /// Owner halts new mints. Does NOT block transfers — collectors
    /// keep their tokens fully usable on marketplaces while paused.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --- views ---

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    // --- required overrides ---

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage, ERC2981)
        returns (bool)
    {
        return interfaceId == _INTERFACE_ID_ERC4906 || super.supportsInterface(interfaceId);
    }
}
