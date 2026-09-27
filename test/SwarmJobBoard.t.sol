// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmJobBoard} from "../src/SwarmJobBoard.sol";

/// @dev Re-enters withdraw() from its receive hook.
contract ReentrantWithdrawer {
    SwarmJobBoard internal immutable board;
    uint256 public entries;

    constructor(SwarmJobBoard board_) {
        board = board_;
    }

    function commit(uint256 taskId, bytes32 c) external {
        board.commit(taskId, c);
    }

    function reveal(uint256 taskId, bytes32 resultHash, bytes32 salt) external {
        board.reveal(taskId, resultHash, salt);
    }

    function withdraw() external {
        board.withdraw();
    }

    receive() external payable {
        entries += 1;
        if (entries < 3) board.withdraw();
    }
}

/// @dev Refuses every ETH transfer.
contract RejectingReceiver {
    SwarmJobBoard internal immutable board;

    constructor(SwarmJobBoard board_) {
        board = board_;
    }

    function post(bytes32 specHash, uint64 deadline) external payable returns (uint256) {
        return board.post{value: msg.value}(specHash, deadline);
    }

    function cancel(uint256 taskId) external {
        board.cancel(taskId);
    }

    function withdraw() external {
        board.withdraw();
    }
}

contract SwarmJobBoardTest is Test {
    uint256 internal constant START = 1_700_000_000;
    uint256 internal constant REWARD = 0.01 ether;
    bytes32 internal constant SPEC = keccak256("spec");

    SwarmJobBoard internal board;

    address internal poster = makeAddr("poster");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant RESULT_A = keccak256("result-alice");
    bytes32 internal constant SALT_A = keccak256("salt-alice");
    bytes32 internal constant RESULT_B = keccak256("result-bob");
    bytes32 internal constant SALT_B = keccak256("salt-bob");

    function setUp() public {
        vm.warp(START);
        board = new SwarmJobBoard();
        vm.deal(poster, 100 ether);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.deal(carol, 1 ether);
        vm.deal(stranger, 1 ether);
    }

    // ------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------

    function _commitment(bytes32 resultHash, bytes32 salt, address worker, uint256 taskId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(resultHash, salt, worker, taskId));
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 2 days);
    }

    function _post() internal returns (uint256 id, uint64 deadline) {
        return _post(REWARD);
    }

    function _post(uint256 reward) internal returns (uint256 id, uint64 deadline) {
        deadline = _deadline();
        vm.prank(poster);
        id = board.post{value: reward}(SPEC, deadline);
    }

    function _commit(uint256 id, address worker, bytes32 resultHash, bytes32 salt) internal {
        vm.prank(worker);
        board.commit(id, _commitment(resultHash, salt, worker, id));
    }

    function _reveal(uint256 id, address worker, bytes32 resultHash, bytes32 salt) internal {
        vm.prank(worker);
        board.reveal(id, resultHash, salt);
    }

    /// @dev Posts, has alice and bob commit and reveal, and leaves time at the start of the decision window.
    function _postWithTwoReveals() internal returns (uint256 id, uint64 deadline) {
        (id, deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        _commit(id, bob, RESULT_B, SALT_B);
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        _reveal(id, bob, RESULT_B, SALT_B);
        vm.warp(deadline + 1 days);
    }

    function _owed() internal view returns (uint256) {
        return board.withdrawable(poster) + board.withdrawable(alice) + board.withdrawable(bob)
            + board.withdrawable(carol) + board.withdrawable(stranger);
    }

    // ------------------------------------------------------------------------------------------
    // Deployment shape
    // ------------------------------------------------------------------------------------------

    function test_plainEthTransferReverts() public {
        vm.prank(poster);
        (bool ok,) = address(board).call{value: 1 ether}("");
        assertFalse(ok, "plain ETH must be refused");
        assertEq(address(board).balance, 0);
    }

    function test_unknownCalldataReverts() public {
        vm.prank(poster);
        (bool ok,) = address(board).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        (ok,) = address(board).call(hex"deadbeef");
        assertFalse(ok);
    }

    function test_constants() public view {
        assertEq(board.MIN_REWARD(), 0.0001 ether);
        assertEq(board.MIN_DURATION(), 1 hours);
        assertEq(board.MAX_DURATION(), 30 days);
        assertEq(board.REVEAL_WINDOW(), 1 days);
        assertEq(board.DECISION_END(), 7 days);
        assertEq(board.taskCount(), 0);
    }

    // ------------------------------------------------------------------------------------------
    // post
    // ------------------------------------------------------------------------------------------

    function test_post() public {
        uint64 deadline = _deadline();
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Posted(1, poster, SPEC, REWARD, deadline);
        vm.prank(poster);
        uint256 id = board.post{value: REWARD}(SPEC, deadline);

        assertEq(id, 1);
        assertEq(board.taskCount(), 1);
        SwarmJobBoard.Task memory t = board.task(id);
        assertEq(t.poster, poster);
        assertEq(t.deadline, deadline);
        assertEq(uint8(t.status), uint8(SwarmJobBoard.Status.Open));
        assertEq(t.specHash, SPEC);
        assertEq(t.reward, REWARD);
        assertEq(t.commitCount, 0);
        assertEq(t.revealedCount, 0);
        assertEq(t.share, 0);
        assertEq(address(board).balance, REWARD);
    }

    function test_postIdsIncrement() public {
        (uint256 first,) = _post();
        (uint256 second,) = _post();
        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(board.taskCount(), 2);
    }

    function test_postExactMinimumReward() public {
        vm.prank(poster);
        board.post{value: 0.0001 ether}(SPEC, _deadline());
    }

    function test_postRevertsBelowMinimumReward() public {
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.RewardTooSmall.selector);
        board.post{value: 0.0001 ether - 1}(SPEC, _deadline());
    }

    function test_postDeadlineBoundaries() public {
        vm.startPrank(poster);
        board.post{value: REWARD}(SPEC, uint64(block.timestamp + 1 hours));
        board.post{value: REWARD}(SPEC, uint64(block.timestamp + 30 days));

        vm.expectRevert(SwarmJobBoard.DeadlineOutOfRange.selector);
        board.post{value: REWARD}(SPEC, uint64(block.timestamp + 1 hours - 1));
        vm.expectRevert(SwarmJobBoard.DeadlineOutOfRange.selector);
        board.post{value: REWARD}(SPEC, uint64(block.timestamp + 30 days + 1));
        vm.expectRevert(SwarmJobBoard.DeadlineOutOfRange.selector);
        board.post{value: REWARD}(SPEC, 0);
        vm.stopPrank();
    }

    function testFuzz_postDeadlineRange(uint64 offset) public {
        offset = uint64(bound(offset, 0, 60 days));
        uint64 deadline = uint64(block.timestamp) + offset;
        bool valid = offset >= 1 hours && offset <= 30 days;
        vm.prank(poster);
        if (!valid) vm.expectRevert(SwarmJobBoard.DeadlineOutOfRange.selector);
        board.post{value: REWARD}(SPEC, deadline);
    }

    // ------------------------------------------------------------------------------------------
    // commit
    // ------------------------------------------------------------------------------------------

    function test_commit() public {
        (uint256 id,) = _post();
        bytes32 c = _commitment(RESULT_A, SALT_A, alice, id);
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Committed(id, alice, c);
        vm.prank(alice);
        board.commit(id, c);

        SwarmJobBoard.Submission memory s = board.submission(id, alice);
        assertEq(s.commitment, c);
        assertFalse(s.revealed);
        assertFalse(s.splitClaimed);
        assertEq(board.task(id).commitCount, 1);
    }

    function test_commitJustBeforeDeadlineSucceeds() public {
        (uint256 id, uint64 deadline) = _post();
        vm.warp(deadline - 1);
        _commit(id, alice, RESULT_A, SALT_A);
    }

    function test_commitAtDeadlineReverts() public {
        (uint256 id, uint64 deadline) = _post();
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.CommitPhaseOver.selector);
        board.commit(id, _commitment(RESULT_A, SALT_A, alice, id));
    }

    function test_commitByPosterReverts() public {
        (uint256 id,) = _post();
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.PosterCannotCommit.selector);
        board.commit(id, _commitment(RESULT_A, SALT_A, poster, id));
    }

    function test_commitTwiceReverts() public {
        (uint256 id,) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.AlreadyCommitted.selector);
        board.commit(id, _commitment(RESULT_B, SALT_B, alice, id));
    }

    function test_commitZeroReverts() public {
        (uint256 id,) = _post();
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.EmptyCommitment.selector);
        board.commit(id, bytes32(0));
    }

    function test_commitUnknownTaskReverts() public {
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.commit(42, _commitment(RESULT_A, SALT_A, alice, 42));
    }

    function test_manyCommitsNeverBlockAnyone() public {
        (uint256 id, uint64 deadline) = _post();
        for (uint160 i = 1; i <= 200; ++i) {
            address w = address(uint160(0x10000) + i);
            vm.prank(w);
            board.commit(id, _commitment(RESULT_A, bytes32(uint256(i)), w, id));
        }
        _commit(id, alice, RESULT_A, SALT_A);
        assertEq(board.task(id).commitCount, 201);
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline + 7 days);
        board.finalize(id);
        assertEq(board.task(id).share, REWARD);
    }

    // ------------------------------------------------------------------------------------------
    // reveal
    // ------------------------------------------------------------------------------------------

    function test_reveal() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline);
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Revealed(id, alice, RESULT_A);
        _reveal(id, alice, RESULT_A, SALT_A);

        SwarmJobBoard.Submission memory s = board.submission(id, alice);
        assertTrue(s.revealed);
        assertEq(s.resultHash, RESULT_A);
        assertEq(board.revealedCount(id), 1);
        assertEq(board.task(id).revealedCount, 1);
    }

    function test_revealBeforeDeadlineReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline - 1);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotInRevealWindow.selector);
        board.reveal(id, RESULT_A, SALT_A);
    }

    function test_revealJustBeforeWindowEndSucceeds() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline + 1 days - 1);
        _reveal(id, alice, RESULT_A, SALT_A);
        assertEq(board.revealedCount(id), 1);
    }

    function test_revealAtDeadlinePlusOneDayReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline + 1 days);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotInRevealWindow.selector);
        board.reveal(id, RESULT_A, SALT_A);
    }

    function test_revealWrongSaltReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.BadReveal.selector);
        board.reveal(id, RESULT_A, keccak256("wrong"));
        assertEq(board.revealedCount(id), 0);
    }

    function test_revealWrongResultReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.BadReveal.selector);
        board.reveal(id, RESULT_B, SALT_A);
    }

    function test_copiedCommitmentCannotBeRevealed() public {
        (uint256 id, uint64 deadline) = _post();
        bytes32 aliceCommitment = _commitment(RESULT_A, SALT_A, alice, id);
        vm.prank(alice);
        board.commit(id, aliceCommitment);
        // Bob copies Alice's on-chain commitment byte for byte.
        vm.prank(bob);
        board.commit(id, aliceCommitment);

        vm.warp(deadline);
        // Even if Bob later learns Alice's result hash and salt, the commitment is bound to Alice.
        vm.prank(bob);
        vm.expectRevert(SwarmJobBoard.BadReveal.selector);
        board.reveal(id, RESULT_A, SALT_A);
        assertFalse(board.submission(id, bob).revealed);

        // Alice can still reveal her own.
        _reveal(id, alice, RESULT_A, SALT_A);
        assertEq(board.revealedCount(id), 1);
    }

    function test_commitmentIsBoundToTaskId() public {
        (uint256 first, uint64 d1) = _post();
        (uint256 second,) = _post();
        // Alice reuses the exact commitment she used for task 1 on task 2.
        bytes32 c = _commitment(RESULT_A, SALT_A, alice, first);
        vm.prank(alice);
        board.commit(second, c);
        vm.warp(d1);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.BadReveal.selector);
        board.reveal(second, RESULT_A, SALT_A);
    }

    function test_revealWithoutCommitReverts() public {
        (uint256 id, uint64 deadline) = _post();
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotCommitted.selector);
        board.reveal(id, RESULT_A, SALT_A);
    }

    function test_revealTwiceReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.AlreadyRevealed.selector);
        board.reveal(id, RESULT_A, SALT_A);
        assertEq(board.revealedCount(id), 1);
    }

    // ------------------------------------------------------------------------------------------
    // accept
    // ------------------------------------------------------------------------------------------

    function test_accept() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Accepted(id, alice, REWARD);
        vm.prank(poster);
        board.accept(id, alice);

        assertEq(uint8(board.task(id).status), uint8(SwarmJobBoard.Status.Accepted));
        assertEq(board.withdrawable(alice), REWARD);
        assertEq(board.withdrawable(bob), 0);
        assertEq(board.withdrawable(poster), 0);
        assertEq(address(board).balance, _owed());
    }

    function test_acceptAtStartOfDecisionWindow() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        assertEq(block.timestamp, deadline + 1 days);
        vm.prank(poster);
        board.accept(id, alice);
    }

    function test_acceptJustBeforeDecisionEnd() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days - 1);
        vm.prank(poster);
        board.accept(id, alice);
    }

    function test_acceptBeforeDeadlinePlusOneDayReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline + 1 days - 1);
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.NotInDecisionWindow.selector);
        board.accept(id, alice);
    }

    function test_acceptDuringCommitPhaseReverts() public {
        (uint256 id,) = _post();
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.NotInDecisionWindow.selector);
        board.accept(id, alice);
    }

    function test_acceptAfterDecisionWindowReverts() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days);
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.NotInDecisionWindow.selector);
        board.accept(id, alice);
    }

    function test_acceptByNonPosterReverts() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotPoster.selector);
        board.accept(id, alice);
    }

    function test_acceptUnrevealedWorkerReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        _commit(id, bob, RESULT_B, SALT_B);
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline + 1 days);

        // bob committed but never revealed
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.WorkerNotRevealed.selector);
        board.accept(id, bob);
        // carol never committed
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.WorkerNotRevealed.selector);
        board.accept(id, carol);
        // the poster cannot accept themself
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.WorkerNotRevealed.selector);
        board.accept(id, poster);
        assertEq(uint8(board.task(id).status), uint8(SwarmJobBoard.Status.Open));
    }

    function test_acceptExcludesEverySecondSettlement() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(id, alice);

        vm.startPrank(poster);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.accept(id, bob);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.accept(id, alice);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.rejectAll(id);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.cancel(id);
        vm.stopPrank();

        vm.warp(deadline + 7 days);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.finalize(id);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotFinalized.selector);
        board.claimSplit(id);

        assertEq(board.withdrawable(alice), REWARD);
        assertEq(address(board).balance, _owed());
    }

    // ------------------------------------------------------------------------------------------
    // rejectAll
    // ------------------------------------------------------------------------------------------

    function test_rejectAll() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Rejected(id, REWARD);
        vm.prank(poster);
        board.rejectAll(id);

        assertEq(uint8(board.task(id).status), uint8(SwarmJobBoard.Status.Rejected));
        assertEq(board.withdrawable(poster), REWARD);
        assertEq(board.withdrawable(alice), 0);
        assertEq(board.withdrawable(bob), 0);
    }

    function test_rejectAllWithNoRevealsIsAllowed() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline + 1 days);
        vm.prank(poster);
        board.rejectAll(id);
        assertEq(board.withdrawable(poster), REWARD);
    }

    function test_rejectAllBeforeDecisionWindowReverts() public {
        (uint256 id, uint64 deadline) = _post();
        vm.warp(deadline + 1 days - 1);
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.NotInDecisionWindow.selector);
        board.rejectAll(id);
    }

    function test_rejectAllAfterDecisionWindowReverts() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days);
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.NotInDecisionWindow.selector);
        board.rejectAll(id);
    }

    function test_rejectAllByNonPosterReverts() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.prank(stranger);
        vm.expectRevert(SwarmJobBoard.NotPoster.selector);
        board.rejectAll(id);
    }

    function test_rejectAllExcludesEverySecondSettlement() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.prank(poster);
        board.rejectAll(id);

        vm.startPrank(poster);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.rejectAll(id);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.accept(id, alice);
        vm.stopPrank();

        vm.warp(deadline + 7 days);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.finalize(id);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotFinalized.selector);
        board.claimSplit(id);

        assertEq(board.withdrawable(poster), REWARD);
        assertEq(address(board).balance, _owed());
    }

    // ------------------------------------------------------------------------------------------
    // cancel
    // ------------------------------------------------------------------------------------------

    function test_cancel() public {
        (uint256 id,) = _post();
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Cancelled(id, REWARD);
        vm.prank(poster);
        board.cancel(id);

        assertEq(uint8(board.task(id).status), uint8(SwarmJobBoard.Status.Cancelled));
        assertEq(board.withdrawable(poster), REWARD);

        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.commit(id, _commitment(RESULT_A, SALT_A, alice, id));
    }

    function test_cancelAfterDeadlineWithNoCommitsIsAllowed() public {
        (uint256 id, uint64 deadline) = _post();
        vm.warp(deadline + 3 days);
        vm.prank(poster);
        board.cancel(id);
        assertEq(board.withdrawable(poster), REWARD);
        vm.warp(deadline + 7 days);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.finalize(id);
    }

    function test_cancelAfterCommitReverts() public {
        (uint256 id,) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.HasCommits.selector);
        board.cancel(id);
        assertEq(uint8(board.task(id).status), uint8(SwarmJobBoard.Status.Open));
    }

    function test_cancelByNonPosterReverts() public {
        (uint256 id,) = _post();
        vm.prank(stranger);
        vm.expectRevert(SwarmJobBoard.NotPoster.selector);
        board.cancel(id);
    }

    function test_cancelTwiceReverts() public {
        (uint256 id,) = _post();
        vm.startPrank(poster);
        board.cancel(id);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.cancel(id);
        vm.stopPrank();
        assertEq(board.withdrawable(poster), REWARD);
    }

    // ------------------------------------------------------------------------------------------
    // finalize
    // ------------------------------------------------------------------------------------------

    function test_finalizeWithReveals() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days);
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Finalized(id, REWARD / 2, 2);
        vm.prank(stranger);
        board.finalize(id);

        SwarmJobBoard.Task memory t = board.task(id);
        assertEq(uint8(t.status), uint8(SwarmJobBoard.Status.Finalized));
        assertEq(t.share, REWARD / 2);
        assertEq(board.withdrawable(poster), 0);
        assertEq(board.withdrawable(alice), 0);
    }

    function test_finalizeWithNoRevealsRefundsPoster() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A); // committed, never revealed
        vm.warp(deadline + 7 days);
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Finalized(id, 0, 0);
        board.finalize(id);

        assertEq(board.task(id).share, 0);
        assertEq(board.withdrawable(poster), REWARD);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.WorkerNotRevealed.selector);
        board.claimSplit(id);
    }

    function test_finalizeBeforeDecisionEndReverts() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days - 1);
        vm.expectRevert(SwarmJobBoard.DecisionWindowStillOpen.selector);
        board.finalize(id);
    }

    function test_finalizeUnknownTaskReverts() public {
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.finalize(99);
    }

    function test_finalizeExcludesEverySecondSettlement() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days);
        board.finalize(id);

        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.finalize(id);
        vm.startPrank(poster);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.accept(id, alice);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.rejectAll(id);
        vm.expectRevert(SwarmJobBoard.TaskNotOpen.selector);
        board.cancel(id);
        vm.stopPrank();
    }

    function test_finalizeRemainderWeiGoesToPoster() public {
        uint256 reward = 0.0001 ether + 1; // odd number of wei, two revealers
        uint64 deadline = _deadline();
        vm.prank(poster);
        uint256 id = board.post{value: reward}(SPEC, deadline);
        _commit(id, alice, RESULT_A, SALT_A);
        _commit(id, bob, RESULT_B, SALT_B);
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        _reveal(id, bob, RESULT_B, SALT_B);
        vm.warp(deadline + 7 days);
        board.finalize(id);

        uint256 share = reward / 2;
        assertEq(board.task(id).share, share);
        assertEq(board.withdrawable(poster), 1);

        vm.prank(alice);
        board.claimSplit(id);
        vm.prank(bob);
        board.claimSplit(id);
        assertEq(board.withdrawable(alice), share);
        assertEq(board.withdrawable(bob), share);
        assertEq(share * 2 + 1, reward);
        assertEq(address(board).balance, _owed());
    }

    function test_finalizeThreeWayRemainder() public {
        uint256 reward = 0.0001 ether + 1; // 100000000000001 mod 3 == 2
        uint64 deadline = _deadline();
        vm.prank(poster);
        uint256 id = board.post{value: reward}(SPEC, deadline);
        _commit(id, alice, RESULT_A, SALT_A);
        _commit(id, bob, RESULT_B, SALT_B);
        _commit(id, carol, RESULT_A, SALT_B);
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        _reveal(id, bob, RESULT_B, SALT_B);
        _reveal(id, carol, RESULT_A, SALT_B);
        vm.warp(deadline + 7 days);
        board.finalize(id);

        uint256 share = reward / 3;
        assertEq(board.withdrawable(poster), reward - share * 3);
        assertEq(reward - share * 3, 2);
        vm.prank(alice);
        board.claimSplit(id);
        vm.prank(bob);
        board.claimSplit(id);
        vm.prank(carol);
        board.claimSplit(id);
        assertEq(_owed(), reward);
        assertEq(address(board).balance, reward);
    }

    // ------------------------------------------------------------------------------------------
    // claimSplit
    // ------------------------------------------------------------------------------------------

    function test_claimSplit() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days);
        board.finalize(id);

        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.SplitClaimed(id, alice, REWARD / 2);
        vm.prank(alice);
        board.claimSplit(id);
        assertEq(board.withdrawable(alice), REWARD / 2);
        assertTrue(board.submission(id, alice).splitClaimed);
        assertFalse(board.submission(id, bob).splitClaimed);
    }

    function test_claimSplitTwiceReverts() public {
        (uint256 id, uint64 deadline) = _postWithTwoReveals();
        vm.warp(deadline + 7 days);
        board.finalize(id);
        vm.startPrank(alice);
        board.claimSplit(id);
        vm.expectRevert(SwarmJobBoard.SplitAlreadyClaimed.selector);
        board.claimSplit(id);
        vm.stopPrank();
        assertEq(board.withdrawable(alice), REWARD / 2);
    }

    function test_claimSplitByNonRevealerReverts() public {
        (uint256 id, uint64 deadline) = _post();
        _commit(id, alice, RESULT_A, SALT_A);
        _commit(id, bob, RESULT_B, SALT_B); // never reveals
        vm.warp(deadline);
        _reveal(id, alice, RESULT_A, SALT_A);
        vm.warp(deadline + 7 days);
        board.finalize(id);
        assertEq(board.task(id).share, REWARD);

        vm.prank(bob);
        vm.expectRevert(SwarmJobBoard.WorkerNotRevealed.selector);
        board.claimSplit(id);
        vm.prank(carol);
        vm.expectRevert(SwarmJobBoard.WorkerNotRevealed.selector);
        board.claimSplit(id);
        vm.prank(poster);
        vm.expectRevert(SwarmJobBoard.WorkerNotRevealed.selector);
        board.claimSplit(id);

        vm.prank(alice);
        board.claimSplit(id);
        assertEq(board.withdrawable(alice), REWARD);
        assertEq(address(board).balance, _owed());
    }

    function test_claimSplitBeforeFinalizeReverts() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotFinalized.selector);
        board.claimSplit(id);
    }

    function test_claimSplitOnAcceptedTaskReverts() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(id, alice);
        vm.prank(bob);
        vm.expectRevert(SwarmJobBoard.NotFinalized.selector);
        board.claimSplit(id);
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NotFinalized.selector);
        board.claimSplit(id);
    }

    // ------------------------------------------------------------------------------------------
    // withdraw
    // ------------------------------------------------------------------------------------------

    function test_withdraw() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(id, alice);

        uint256 before = alice.balance;
        vm.expectEmit(true, true, true, true);
        emit SwarmJobBoard.Withdrawn(alice, REWARD);
        vm.prank(alice);
        board.withdraw();

        assertEq(alice.balance, before + REWARD);
        assertEq(board.withdrawable(alice), 0);
        assertEq(address(board).balance, 0);
    }

    function test_withdrawNothingReverts() public {
        vm.prank(alice);
        vm.expectRevert(SwarmJobBoard.NothingToWithdraw.selector);
        board.withdraw();
    }

    function test_withdrawTwiceReverts() public {
        (uint256 id,) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(id, alice);
        vm.startPrank(alice);
        board.withdraw();
        vm.expectRevert(SwarmJobBoard.NothingToWithdraw.selector);
        board.withdraw();
        vm.stopPrank();
    }

    function test_withdrawAccumulatesAcrossTasks() public {
        (uint256 first,) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(first, alice);
        (uint256 second,) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(second, alice);
        assertEq(board.withdrawable(alice), 2 * REWARD);
        vm.prank(alice);
        board.withdraw();
        assertEq(alice.balance, 1 ether + 2 * REWARD);
    }

    function test_withdrawReentrancyIsBlocked() public {
        ReentrantWithdrawer attacker = new ReentrantWithdrawer(board);
        (uint256 id, uint64 deadline) = _post();
        attacker.commit(id, _commitment(RESULT_A, SALT_A, address(attacker), id));
        vm.warp(deadline);
        attacker.reveal(id, RESULT_A, SALT_A);
        vm.warp(deadline + 1 days);
        vm.prank(poster);
        board.accept(id, address(attacker));

        // A second, unrelated task keeps extra ETH in the contract for the attacker to try for.
        _post();
        assertEq(address(board).balance, 2 * REWARD);

        vm.expectRevert(SwarmJobBoard.TransferFailed.selector);
        attacker.withdraw();

        assertEq(address(attacker).balance, 0);
        assertEq(board.withdrawable(address(attacker)), REWARD);
        assertEq(address(board).balance, 2 * REWARD);
    }

    function test_rejectingReceiverOnlyBlocksItself() public {
        RejectingReceiver rejecting = new RejectingReceiver(board);
        vm.deal(address(rejecting), 1 ether);
        uint256 id = rejecting.post{value: REWARD}(SPEC, _deadline());
        rejecting.cancel(id);
        assertEq(board.withdrawable(address(rejecting)), REWARD);

        vm.expectRevert(SwarmJobBoard.TransferFailed.selector);
        rejecting.withdraw();
        assertEq(board.withdrawable(address(rejecting)), REWARD);

        // Other users are unaffected.
        (uint256 other,) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(other, bob);
        vm.prank(bob);
        board.withdraw();
        assertEq(bob.balance, 1 ether + REWARD);
        assertEq(address(board).balance, REWARD);
    }

    // ------------------------------------------------------------------------------------------
    // Conservation across a mixed lifecycle
    // ------------------------------------------------------------------------------------------

    function test_fundsAreConservedAcrossMixedOutcomes() public {
        (uint256 t1,) = _postWithTwoReveals();
        vm.prank(poster);
        board.accept(t1, alice);

        (uint256 t2,) = _postWithTwoReveals();
        vm.prank(poster);
        board.rejectAll(t2);

        (uint256 t3,) = _post();
        vm.prank(poster);
        board.cancel(t3);

        (uint256 t4, uint64 d4) = _postWithTwoReveals();
        vm.warp(d4 + 7 days);
        board.finalize(t4);
        vm.prank(alice);
        board.claimSplit(t4);

        // Open: none. Unclaimed split: bob's half of t4.
        uint256 unclaimed = REWARD / 2;
        assertEq(address(board).balance, 4 * REWARD);
        assertEq(address(board).balance, _owed() + unclaimed);

        vm.prank(bob);
        board.claimSplit(t4);
        assertEq(address(board).balance, _owed());

        vm.prank(alice);
        board.withdraw();
        vm.prank(bob);
        board.withdraw();
        vm.prank(poster);
        board.withdraw();
        assertEq(address(board).balance, 0);
        assertEq(alice.balance, 1 ether + REWARD + REWARD / 2);
        assertEq(bob.balance, 1 ether + REWARD / 2);
        assertEq(poster.balance, 100 ether - 2 * REWARD);
    }
}
