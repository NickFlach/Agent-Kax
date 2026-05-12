// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

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
 * Ownership uses Ownable2Step — `transferOwnership` is a propose, and
 * the new owner must call `acceptOwnership` to take it. A fat-fingered
 * transfer to a wrong address can't brick the contract.
 *
 * EIP-4906 (`MetadataUpdate` / `BatchMetadataUpdate`) is advertised via
 * `supportsInterface` so marketplaces know they may refresh metadata
 * for tokens minted here. We do not currently emit those events
 * (there is no update path), but the interface bit is honest about
 * the contract's stance toward metadata refreshes.
 */
contract KannakaArtifact is ERC721, ERC721URIStorage, Ownable2Step {
    /// EIP-4906 interface id, per the spec.
    bytes4 private constant _INTERFACE_ID_ERC4906 = 0x49064906;

    uint256 private _nextTokenId = 1;

    /// OpenBotCity artifact UUID -> on-chain tokenId.
    mapping(string => uint256) public tokenIdForArtifact;

    /// Explicit gate. Replaces the implicit `tokenId == 0` sentinel so
    /// the invariant doesn't break the day someone changes `_nextTokenId`'s
    /// initial value or adds a burn path.
    mapping(string => bool) public mintedArtifact;

    event ArtifactMinted(
        uint256 indexed tokenId,
        address indexed to,
        string artifactUuid,
        string tokenURI
    );

    error EmptyArtifactUuid();
    error AlreadyMinted(string artifactUuid);

    constructor(address initialOwner)
        ERC721("Kannaka Artifact", "KAX")
        Ownable(initialOwner)
    {}

    /**
     * Mint a 1-of-1 token for an OpenBotCity artifact UUID.
     * Reverts if the same artifact UUID has already been minted here,
     * or if `artifactUuid` is empty.
     */
    function mintArtifact(
        address to,
        string calldata artifactUuid,
        string calldata uri
    ) external onlyOwner returns (uint256) {
        if (bytes(artifactUuid).length == 0) revert EmptyArtifactUuid();
        if (mintedArtifact[artifactUuid]) revert AlreadyMinted(artifactUuid);

        uint256 tokenId = _nextTokenId++;

        // Effects BEFORE the `_safeMint` interaction. `_safeMint` calls
        // `onERC721Received` on `to` when it's a contract — a malicious
        // receiver that tried to re-enter `mintArtifact(_, sameUuid, _)`
        // here will hit `AlreadyMinted` because the gate is already set.
        mintedArtifact[artifactUuid] = true;
        tokenIdForArtifact[artifactUuid] = tokenId;
        _setTokenURI(tokenId, uri);

        _safeMint(to, tokenId);

        emit ArtifactMinted(tokenId, to, artifactUuid, uri);
        return tokenId;
    }

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
        override(ERC721, ERC721URIStorage)
        returns (bool)
    {
        return interfaceId == _INTERFACE_ID_ERC4906 || super.supportsInterface(interfaceId);
    }
}
