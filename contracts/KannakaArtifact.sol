// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * KannakaArtifact
 * ----------------
 * 1-of-1 ERC-721 collectible contract for the KAX storefront.
 *
 * Each token corresponds to a single OpenBotCity artifact UUID. The
 * `artifactUuid -> tokenId` mapping enforces that any given artifact can
 * only ever be minted once on this contract instance, even if the minter
 * is called twice for the same UUID.
 *
 * Metadata is served from the KAX API at:
 *   https://<your-kax-domain>/api/nft/metadata/<artifactId>.json
 *
 * Deploy notes:
 *   - Owner is the deployer; only the owner may mint.
 *   - Set the contract address + chain id back in KAX via:
 *       POST /api/artifacts/:id/mint
 */
contract KannakaArtifact is ERC721, ERC721URIStorage, Ownable {
    uint256 private _nextTokenId = 1;

    // OpenBotCity artifact UUID -> on-chain tokenId.
    mapping(string => uint256) public tokenIdForArtifact;

    event ArtifactMinted(
        uint256 indexed tokenId,
        address indexed to,
        string artifactUuid,
        string tokenURI
    );

    constructor(address initialOwner)
        ERC721("Kannaka Artifact", "KAX")
        Ownable(initialOwner)
    {}

    /**
     * Mint a 1-of-1 token for an OpenBotCity artifact UUID.
     * Reverts if the same artifact UUID has already been minted here.
     */
    function mintArtifact(
        address to,
        string calldata artifactUuid,
        string calldata uri
    ) external onlyOwner returns (uint256) {
        require(bytes(artifactUuid).length > 0, "artifactUuid required");
        require(tokenIdForArtifact[artifactUuid] == 0, "already minted");

        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        tokenIdForArtifact[artifactUuid] = tokenId;

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
        return super.supportsInterface(interfaceId);
    }
}
