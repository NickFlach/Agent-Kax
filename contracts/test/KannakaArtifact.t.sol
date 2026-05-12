// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

import "../KannakaArtifact.sol";

/// Receiver that tries to re-enter `mintArtifact` with the same UUID
/// while inside its own `onERC721Received` callback. The reentry should
/// revert because the mapping is set BEFORE `_safeMint`.
contract ReentrantReceiver is IERC721Receiver {
    KannakaArtifact public nft;
    string public uuidToReenter;
    bool public reenterCalled;
    bytes public reenterRevertData;

    function setNft(KannakaArtifact _nft, string calldata _uuid) external {
        nft = _nft;
        uuidToReenter = _uuid;
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        reenterCalled = true;
        try nft.mintArtifact(address(this), uuidToReenter, "ipfs://reentry") {
            // should never reach
            revert("reentry unexpectedly succeeded");
        } catch (bytes memory data) {
            reenterRevertData = data;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract KannakaArtifactTest is Test {
    KannakaArtifact internal nft;
    address internal owner = address(0xA11CE);
    address internal alice = address(0xB0B);
    address internal bob = address(0xCAFE);

    string constant URI_1 = "ipfs://bafyone";
    string constant URI_2 = "ipfs://bafytwo";
    string constant UUID_1 = "4623809f-7960-4ed3-aa6e-c9456afd03a7";
    string constant UUID_2 = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";

    event ArtifactMinted(
        uint256 indexed tokenId,
        address indexed to,
        string artifactUuid,
        string tokenURI
    );

    function setUp() public {
        vm.prank(owner);
        nft = new KannakaArtifact(owner);
    }

    // ---------- happy path ----------

    function test_FirstMint_AssignsTokenId1AndUpdatesMappings() public {
        vm.prank(owner);
        uint256 tokenId = nft.mintArtifact(alice, UUID_1, URI_1);

        assertEq(tokenId, 1, "first tokenId should be 1");
        assertEq(nft.ownerOf(1), alice, "alice owns token 1");
        assertEq(nft.tokenURI(1), URI_1, "tokenURI matches");
        assertEq(nft.tokenIdForArtifact(UUID_1), 1, "uuid -> tokenId");
        assertTrue(nft.mintedArtifact(UUID_1), "minted gate flipped");
        assertEq(nft.nextTokenId(), 2, "_nextTokenId advanced");
    }

    function test_TwoDistinctUuids_MintIndependently() public {
        vm.startPrank(owner);
        uint256 t1 = nft.mintArtifact(alice, UUID_1, URI_1);
        uint256 t2 = nft.mintArtifact(bob, UUID_2, URI_2);
        vm.stopPrank();

        assertEq(t1, 1);
        assertEq(t2, 2);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.ownerOf(2), bob);
        assertEq(nft.tokenIdForArtifact(UUID_1), 1);
        assertEq(nft.tokenIdForArtifact(UUID_2), 2);
    }

    function test_EmitsArtifactMintedEvent() public {
        vm.expectEmit(true, true, false, true, address(nft));
        emit ArtifactMinted(1, alice, UUID_1, URI_1);
        vm.prank(owner);
        nft.mintArtifact(alice, UUID_1, URI_1);
    }

    // ---------- access control ----------

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        nft.mintArtifact(alice, UUID_1, URI_1);
    }

    function test_Ownable2Step_TransferRequiresAccept() public {
        vm.prank(owner);
        nft.transferOwnership(alice);

        // Ownership has NOT moved yet — owner is still `owner`.
        assertEq(nft.owner(), owner, "transfer is two-step; pending until accept");
        assertEq(nft.pendingOwner(), alice, "alice is pending");

        // Pre-accept, alice still cannot mint.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        nft.mintArtifact(alice, UUID_1, URI_1);

        // Accept and confirm ownership moved.
        vm.prank(alice);
        nft.acceptOwnership();
        assertEq(nft.owner(), alice, "alice now owner");

        vm.prank(alice);
        uint256 t = nft.mintArtifact(alice, UUID_1, URI_1);
        assertEq(t, 1);
    }

    function test_Ownable2Step_WrongAcceptorCannotClaim() public {
        vm.prank(owner);
        nft.transferOwnership(alice);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob)
        );
        nft.acceptOwnership();
    }

    // ---------- input validation ----------

    function test_RevertWhen_EmptyUuid() public {
        vm.prank(owner);
        vm.expectRevert(KannakaArtifact.EmptyArtifactUuid.selector);
        nft.mintArtifact(alice, "", URI_1);
    }

    function test_RevertWhen_UuidAlreadyMinted() public {
        vm.startPrank(owner);
        nft.mintArtifact(alice, UUID_1, URI_1);

        vm.expectRevert(
            abi.encodeWithSelector(KannakaArtifact.AlreadyMinted.selector, UUID_1)
        );
        nft.mintArtifact(bob, UUID_1, URI_2);
        vm.stopPrank();
    }

    // ---------- reentrancy via ERC721 receiver ----------

    function test_ReentrantReceiver_CannotDoubleMintSameUuid() public {
        ReentrantReceiver r = new ReentrantReceiver();
        r.setNft(nft, UUID_1);

        // `r` is the owner-deployed contract here, but it's not the
        // contract owner — so the inner re-entry attempt would also
        // fail Ownable's check. To make the reentry test meaningful
        // for the gate itself (M-3), grant ownership to `r`.
        vm.prank(owner);
        nft.transferOwnership(address(r));
        vm.prank(address(r));
        nft.acceptOwnership();

        vm.prank(address(r));
        uint256 tokenId = nft.mintArtifact(address(r), UUID_1, URI_1);

        assertEq(tokenId, 1, "outer mint succeeds");
        assertTrue(r.reenterCalled(), "receiver callback fired");

        // The inner reentry attempt must have reverted with AlreadyMinted
        // — proof that the mapping was set BEFORE `_safeMint`.
        bytes memory rev = r.reenterRevertData();
        bytes4 sel;
        assembly { sel := mload(add(rev, 0x20)) }
        assertEq(sel, KannakaArtifact.AlreadyMinted.selector, "reentry hit AlreadyMinted gate");
    }

    // ---------- supportsInterface ----------

    function test_SupportsInterface_ERC165AndERC721AndERC4906() public view {
        // IERC165
        assertTrue(nft.supportsInterface(0x01ffc9a7));
        // IERC721
        assertTrue(nft.supportsInterface(0x80ac58cd));
        // IERC721Metadata
        assertTrue(nft.supportsInterface(0x5b5e139f));
        // IERC4906 (metadata update events)
        assertTrue(nft.supportsInterface(0x49064906));
        // Random unrelated id
        assertFalse(nft.supportsInterface(0xdeadbeef));
    }

    // ---------- nextTokenId monotonicity ----------

    function testFuzz_NextTokenIdMatchesMintCount(uint8 n) public {
        vm.assume(n > 0 && n < 32);
        vm.startPrank(owner);
        for (uint8 i = 0; i < n; i++) {
            string memory uuid = string.concat("uuid-", vm.toString(i));
            nft.mintArtifact(alice, uuid, URI_1);
        }
        vm.stopPrank();
        assertEq(nft.nextTokenId(), uint256(n) + 1);
    }
}
