// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "../src/KannakaArtifact.sol";

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
    address internal royaltyReceiver = address(0xCAFEBABE);
    uint96 internal constant DEFAULT_ROYALTY_BPS = 750; // 7.5%

    string constant URI_1 = "ipfs://bafyone";
    string constant URI_2 = "ipfs://bafytwo";
    string constant UUID_1 = "4623809f-7960-4ed3-aa6e-c9456afd03a7";
    string constant UUID_2 = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";
    string constant UUID_3 = "11111111-2222-3333-4444-555555555555";

    event ArtifactMinted(
        uint256 indexed tokenId,
        address indexed to,
        string artifactUuid,
        string tokenURI
    );

    function setUp() public {
        vm.prank(owner);
        nft = new KannakaArtifact(owner, royaltyReceiver, DEFAULT_ROYALTY_BPS);
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

        assertEq(nft.owner(), owner, "transfer is two-step; pending until accept");
        assertEq(nft.pendingOwner(), alice, "alice is pending");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        nft.mintArtifact(alice, UUID_1, URI_1);

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

    function test_RevertWhen_EmptyUri() public {
        vm.prank(owner);
        vm.expectRevert(KannakaArtifact.EmptyUri.selector);
        nft.mintArtifact(alice, UUID_1, "");
    }

    function test_RevertWhen_UuidTooLong() public {
        // Build a 65-byte UUID (one over the cap).
        bytes memory big = new bytes(65);
        for (uint256 i = 0; i < big.length; i++) big[i] = "u";
        string memory bigUuid = string(big);
        uint256 maxBytes = nft.MAX_ARTIFACT_UUID_BYTES();

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(KannakaArtifact.ArtifactUuidTooLong.selector, 65, maxBytes)
        );
        nft.mintArtifact(alice, bigUuid, URI_1);
    }

    function test_UuidAtMaxLength_Succeeds() public {
        // A UUID exactly at the cap (64 bytes) must mint successfully —
        // the cap is inclusive.
        bytes memory atMax = new bytes(64);
        for (uint256 i = 0; i < atMax.length; i++) atMax[i] = "u";
        string memory uuid = string(atMax);

        vm.prank(owner);
        uint256 tokenId = nft.mintArtifact(alice, uuid, URI_1);
        assertEq(tokenId, 1);
        assertTrue(nft.mintedArtifact(uuid));
    }

    function test_RevertWhen_UriTooLong() public {
        // Build a 513-byte URI (one over the cap).
        bytes memory big = new bytes(513);
        for (uint256 i = 0; i < big.length; i++) big[i] = "a";
        string memory bigUri = string(big);
        uint256 maxBytes = nft.MAX_URI_BYTES();

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(KannakaArtifact.UriTooLong.selector, 513, maxBytes)
        );
        nft.mintArtifact(alice, UUID_1, bigUri);
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

        // Grant ownership to `r` so the inner reentry attempt isn't
        // simply blocked by Ownable. The reentry must hit `AlreadyMinted`
        // — proof that the mapping was set BEFORE `_safeMint`.
        vm.prank(owner);
        nft.transferOwnership(address(r));
        vm.prank(address(r));
        nft.acceptOwnership();

        vm.prank(address(r));
        uint256 tokenId = nft.mintArtifact(address(r), UUID_1, URI_1);

        assertEq(tokenId, 1, "outer mint succeeds");
        assertTrue(r.reenterCalled(), "receiver callback fired");

        bytes memory rev = r.reenterRevertData();
        bytes4 sel;
        assembly { sel := mload(add(rev, 0x20)) }
        assertEq(sel, KannakaArtifact.AlreadyMinted.selector, "reentry hit AlreadyMinted gate");
    }

    // ---------- ERC-2981 royalties ----------

    function test_DefaultRoyalty_SetInConstructor() public view {
        (address recv, uint256 amount) = nft.royaltyInfo(1, 10_000);
        assertEq(recv, royaltyReceiver, "default receiver");
        assertEq(amount, DEFAULT_ROYALTY_BPS, "7.5% on 10_000 sale = 750");
    }

    function test_DefaultRoyalty_ScalesWithSalePrice() public view {
        (address recv, uint256 amount) = nft.royaltyInfo(1, 1 ether);
        assertEq(recv, royaltyReceiver);
        // 7.5% of 1e18 = 7.5e16
        assertEq(amount, (1 ether * DEFAULT_ROYALTY_BPS) / 10_000);
    }

    function test_SetDefaultRoyalty_UpdatesValue() public {
        vm.prank(owner);
        nft.setDefaultRoyalty(alice, 1000); // 10%

        (address recv, uint256 amount) = nft.royaltyInfo(42, 5 ether);
        assertEq(recv, alice);
        assertEq(amount, (5 ether * 1000) / 10_000);
    }

    function test_DeleteDefaultRoyalty_ZerosFallback() public {
        vm.prank(owner);
        nft.deleteDefaultRoyalty();

        (address recv, uint256 amount) = nft.royaltyInfo(1, 1 ether);
        assertEq(recv, address(0));
        assertEq(amount, 0);
    }

    function test_PerTokenRoyalty_OverridesDefault() public {
        vm.startPrank(owner);
        nft.mintArtifact(alice, UUID_1, URI_1);
        nft.setTokenRoyalty(1, bob, 200); // 2% on token 1 only
        vm.stopPrank();

        (address recv1, uint256 amt1) = nft.royaltyInfo(1, 10_000);
        assertEq(recv1, bob, "token 1 uses override");
        assertEq(amt1, 200);

        // A different (unminted) token still follows the default.
        (address recv2, uint256 amt2) = nft.royaltyInfo(2, 10_000);
        assertEq(recv2, royaltyReceiver);
        assertEq(amt2, DEFAULT_ROYALTY_BPS);
    }

    function test_ResetTokenRoyalty_FallsBackToDefault() public {
        vm.startPrank(owner);
        nft.mintArtifact(alice, UUID_1, URI_1);
        nft.setTokenRoyalty(1, bob, 200);
        nft.resetTokenRoyalty(1);
        vm.stopPrank();

        (address recv, uint256 amount) = nft.royaltyInfo(1, 10_000);
        assertEq(recv, royaltyReceiver);
        assertEq(amount, DEFAULT_ROYALTY_BPS);
    }

    function test_RevertWhen_NonOwnerSetsRoyalty() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        nft.setDefaultRoyalty(alice, 1000);
    }

    function test_DeployWithoutRoyalty_LeavesItUnset() public {
        vm.prank(owner);
        KannakaArtifact bare = new KannakaArtifact(owner, address(0), 0);
        (address recv, uint256 amount) = bare.royaltyInfo(1, 1 ether);
        assertEq(recv, address(0));
        assertEq(amount, 0);
    }

    // ---------- pausable ----------

    function test_Pause_BlocksMint() public {
        vm.prank(owner);
        nft.pause();

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        nft.mintArtifact(alice, UUID_1, URI_1);
    }

    function test_Unpause_RestoresMint() public {
        vm.startPrank(owner);
        nft.pause();
        nft.unpause();
        uint256 t = nft.mintArtifact(alice, UUID_1, URI_1);
        vm.stopPrank();
        assertEq(t, 1);
    }

    function test_Pause_DoesNotBlockTransfers() public {
        vm.prank(owner);
        nft.mintArtifact(alice, UUID_1, URI_1);

        vm.prank(owner);
        nft.pause();

        // Transfer should still work — pause only halts mint.
        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), bob);
    }

    function test_RevertWhen_NonOwnerPauses() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        nft.pause();
    }

    // ---------- batch mint ----------

    function test_BatchMint_ThreeArtifactsAtomically() public {
        address[] memory recipients = new address[](3);
        recipients[0] = alice; recipients[1] = bob; recipients[2] = alice;
        string[] memory uuids = new string[](3);
        uuids[0] = UUID_1; uuids[1] = UUID_2; uuids[2] = UUID_3;
        string[] memory uris = new string[](3);
        uris[0] = URI_1; uris[1] = URI_2; uris[2] = URI_1;

        vm.prank(owner);
        uint256[] memory ids = nft.mintArtifactBatch(recipients, uuids, uris);

        assertEq(ids.length, 3);
        assertEq(ids[0], 1); assertEq(ids[1], 2); assertEq(ids[2], 3);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.ownerOf(2), bob);
        assertEq(nft.ownerOf(3), alice);
        assertEq(nft.nextTokenId(), 4);
    }

    function test_BatchMint_AnyDuplicateRevertsEntireBatch() public {
        // Pre-mint UUID_2 so position [1] in the batch will collide.
        vm.prank(owner);
        nft.mintArtifact(alice, UUID_2, URI_2);
        uint256 nextBefore = nft.nextTokenId();

        address[] memory recipients = new address[](3);
        recipients[0] = alice; recipients[1] = bob; recipients[2] = alice;
        string[] memory uuids = new string[](3);
        uuids[0] = UUID_1; uuids[1] = UUID_2; uuids[2] = UUID_3;
        string[] memory uris = new string[](3);
        uris[0] = URI_1; uris[1] = URI_2; uris[2] = URI_1;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(KannakaArtifact.AlreadyMinted.selector, UUID_2)
        );
        nft.mintArtifactBatch(recipients, uuids, uris);

        // No partial state — UUID_1 and UUID_3 must NOT have been minted.
        assertFalse(nft.mintedArtifact(UUID_1));
        assertFalse(nft.mintedArtifact(UUID_3));
        assertEq(nft.nextTokenId(), nextBefore, "nextTokenId untouched");
    }

    function test_BatchMint_RevertOnEmptyBatch() public {
        address[] memory recipients = new address[](0);
        string[] memory uuids = new string[](0);
        string[] memory uris = new string[](0);

        vm.prank(owner);
        vm.expectRevert(KannakaArtifact.EmptyBatch.selector);
        nft.mintArtifactBatch(recipients, uuids, uris);
    }

    function test_BatchMint_RevertOnLengthMismatch() public {
        address[] memory recipients = new address[](2);
        recipients[0] = alice; recipients[1] = bob;
        string[] memory uuids = new string[](2);
        uuids[0] = UUID_1; uuids[1] = UUID_2;
        string[] memory uris = new string[](1); // wrong length
        uris[0] = URI_1;

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(KannakaArtifact.BatchLengthMismatch.selector, 2, 2, 1)
        );
        nft.mintArtifactBatch(recipients, uuids, uris);
    }

    function test_BatchMint_RevertOnTooLargeBatch() public {
        uint256 maxBatch = nft.MAX_BATCH_SIZE();
        uint256 size = maxBatch + 1;
        address[] memory recipients = new address[](size);
        string[] memory uuids = new string[](size);
        string[] memory uris = new string[](size);
        for (uint256 i = 0; i < size; i++) {
            recipients[i] = alice;
            uuids[i] = string.concat("u-", vm.toString(i));
            uris[i] = URI_1;
        }

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(KannakaArtifact.BatchTooLarge.selector, size, maxBatch)
        );
        nft.mintArtifactBatch(recipients, uuids, uris);
    }

    function test_BatchMint_BlockedWhenPaused() public {
        vm.prank(owner);
        nft.pause();

        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        string[] memory uuids = new string[](1);
        uuids[0] = UUID_1;
        string[] memory uris = new string[](1);
        uris[0] = URI_1;

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        nft.mintArtifactBatch(recipients, uuids, uris);
    }

    // ---------- supportsInterface ----------

    function test_SupportsInterface_ERC165AndERC721AndERC4906AndERC2981() public view {
        // IERC165
        assertTrue(nft.supportsInterface(0x01ffc9a7));
        // IERC721
        assertTrue(nft.supportsInterface(0x80ac58cd));
        // IERC721Metadata
        assertTrue(nft.supportsInterface(0x5b5e139f));
        // IERC4906 (metadata update events)
        assertTrue(nft.supportsInterface(0x49064906));
        // IERC2981 (royalties)
        assertTrue(nft.supportsInterface(0x2a55205a));
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
