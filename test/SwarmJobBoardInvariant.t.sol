// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwarmJobBoard} from "../src/SwarmJobBoard.sol";

/// @dev Drives the board through random, time-warped sequences. Each action has a "steered" variant
///      that searches for a task in the right phase and warps forward into the right window, so every
///      settlement path is actually reached, and a "raw" variant that fires at a random task and time,
///      so the revert paths are hit as well. Reverts are tolerated (fail_on_revert = false); the
///      counters record what succeeded.
contract SwarmJobBoardHandler is Test {
    SwarmJobBoard public immutable board;

    address[] public actors;
    mapping(uint256 => mapping(address => bytes32)) internal salts;
    mapping(uint256 => mapping(address => bytes32)) internal results;

    uint256 public posted;
    uint256 public commits;
    uint256 public reveals;
    uint256 public accepted;
    uint256 public rejected;
    uint256 public cancelled;
    uint256 public finalized;
    uint256 public splitsClaimed;
    uint256 public withdrawals;
    uint256 public ethWithdrawn;

    constructor(SwarmJobBoard board_) {
        board = board_;
        for (uint256 i; i < 6; ++i) {
            address a = address(uint160(0xA11CE000 + i));
            actors.push(a);
            vm.deal(a, 1000 ether);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _anyTask(uint256 seed) internal view returns (uint256) {
        uint256 n = board.taskCount();
        if (n == 0) return 0;
        return (seed % n) + 1;
    }

    /// @dev Starting from a random offset, find the first open task whose deadline has not passed.
    function _openTaskInCommitPhase(uint256 seed) internal view returns (uint256) {
        uint256 n = board.taskCount();
        for (uint256 k; k < n; ++k) {
            uint256 id = ((seed + k) % n) + 1;
            SwarmJobBoard.Task memory t = board.task(id);
            if (t.status == SwarmJobBoard.Status.Open && block.timestamp < t.deadline) return id;
        }
        return 0;
    }

    /// @dev Find an open task still reachable in the given window: `before` is the window end offset.
    function _openTaskBefore(uint256 seed, uint256 before) internal view returns (uint256) {
        uint256 n = board.taskCount();
        for (uint256 k; k < n; ++k) {
            uint256 id = ((seed + k) % n) + 1;
            SwarmJobBoard.Task memory t = board.task(id);
            if (t.status == SwarmJobBoard.Status.Open && block.timestamp < uint256(t.deadline) + before) return id;
        }
        return 0;
    }

    function _warpAtLeast(uint256 ts) internal {
        if (block.timestamp < ts) vm.warp(ts);
    }

    // ------------------------------------------------------------------------------------------
    // Time
    // ------------------------------------------------------------------------------------------

    function warp(uint256 dt) external {
        dt = bound(dt, 0, 4 days);
        vm.warp(block.timestamp + dt);
    }

    // ------------------------------------------------------------------------------------------
    // Steered actions
    // ------------------------------------------------------------------------------------------

    function post(uint256 actorSeed, uint256 rewardSeed, uint256 durationSeed) external {
        address a = _actor(actorSeed);
        uint256 reward = bound(rewardSeed, board.MIN_REWARD(), 1 ether);
        uint256 duration = bound(durationSeed, board.MIN_DURATION(), 3 days);
        vm.prank(a);
        board.post{value: reward}(keccak256(abi.encode(rewardSeed)), uint64(block.timestamp + duration));
        posted += 1;
    }

    function commit(uint256 actorSeed, uint256 taskSeed, bytes32 resultHash, bytes32 salt) external {
        uint256 id = _openTaskInCommitPhase(taskSeed);
        if (id == 0) return;
        address a = _actor(actorSeed);
        if (a == board.task(id).poster) a = actors[(actorSeed + 1) % actors.length];
        if (board.submission(id, a).commitment != bytes32(0)) return;
        bytes32 c = keccak256(abi.encode(resultHash, salt, a, id));
        vm.prank(a);
        board.commit(id, c);
        salts[id][a] = salt;
        results[id][a] = resultHash;
        commits += 1;
    }

    function reveal(uint256 actorSeed, uint256 taskSeed) external {
        uint256 id = _openTaskBefore(taskSeed, board.REVEAL_WINDOW());
        if (id == 0) return;
        address a = _actor(actorSeed);
        SwarmJobBoard.Submission memory s = board.submission(id, a);
        if (s.commitment == bytes32(0) || s.revealed) return;
        _warpAtLeast(board.task(id).deadline);
        vm.prank(a);
        board.reveal(id, results[id][a], salts[id][a]);
        reveals += 1;
    }

    function accept(uint256 taskSeed, uint256 workerSeed) external {
        uint256 id = _openTaskBefore(taskSeed, board.DECISION_END());
        if (id == 0) return;
        SwarmJobBoard.Task memory t = board.task(id);
        if (t.revealedCount == 0) return;
        address w;
        for (uint256 k; k < actors.length; ++k) {
            address candidate = actors[(workerSeed + k) % actors.length];
            if (board.submission(id, candidate).revealed) {
                w = candidate;
                break;
            }
        }
        _warpAtLeast(uint256(t.deadline) + board.REVEAL_WINDOW());
        vm.prank(t.poster);
        board.accept(id, w);
        accepted += 1;
    }

    function rejectAll(uint256 taskSeed) external {
        uint256 id = _openTaskBefore(taskSeed, board.DECISION_END());
        if (id == 0) return;
        SwarmJobBoard.Task memory t = board.task(id);
        _warpAtLeast(uint256(t.deadline) + board.REVEAL_WINDOW());
        vm.prank(t.poster);
        board.rejectAll(id);
        rejected += 1;
    }

    function cancel(uint256 taskSeed) external {
        uint256 id = _anyTask(taskSeed);
        if (id == 0) return;
        SwarmJobBoard.Task memory t = board.task(id);
        vm.prank(t.poster);
        board.cancel(id);
        cancelled += 1;
    }

    function finalize(uint256 taskSeed, uint256 actorSeed) external {
        uint256 id = _anyTask(taskSeed);
        if (id == 0) return;
        SwarmJobBoard.Task memory t = board.task(id);
        if (t.status != SwarmJobBoard.Status.Open) return;
        _warpAtLeast(uint256(t.deadline) + board.DECISION_END());
        vm.prank(_actor(actorSeed));
        board.finalize(id);
        finalized += 1;
    }

    function claimSplit(uint256 taskSeed, uint256 actorSeed) external {
        uint256 n = board.taskCount();
        for (uint256 k; k < n; ++k) {
            uint256 id = ((taskSeed + k) % n) + 1;
            if (board.task(id).status != SwarmJobBoard.Status.Finalized) continue;
            for (uint256 j; j < actors.length; ++j) {
                address a = actors[(actorSeed + j) % actors.length];
                SwarmJobBoard.Submission memory s = board.submission(id, a);
                if (s.revealed && !s.splitClaimed) {
                    vm.prank(a);
                    board.claimSplit(id);
                    splitsClaimed += 1;
                    return;
                }
            }
        }
    }

    function withdraw(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        uint256 amount = board.withdrawable(a);
        if (amount == 0) return;
        vm.prank(a);
        board.withdraw();
        withdrawals += 1;
        ethWithdrawn += amount;
    }

    // ------------------------------------------------------------------------------------------
    // Raw actions: random task, random actor, current time. Mostly revert; that is the point.
    // ------------------------------------------------------------------------------------------

    function rawCommit(uint256 actorSeed, uint256 taskSeed, bytes32 c) external {
        vm.prank(_actor(actorSeed));
        board.commit(_anyTask(taskSeed), c);
        commits += 1;
    }

    function rawReveal(uint256 actorSeed, uint256 taskSeed, bytes32 r, bytes32 s) external {
        vm.prank(_actor(actorSeed));
        board.reveal(_anyTask(taskSeed), r, s);
        reveals += 1;
    }

    function rawAccept(uint256 callerSeed, uint256 taskSeed, uint256 workerSeed) external {
        vm.prank(_actor(callerSeed));
        board.accept(_anyTask(taskSeed), _actor(workerSeed));
        accepted += 1;
    }

    function rawRejectAll(uint256 callerSeed, uint256 taskSeed) external {
        vm.prank(_actor(callerSeed));
        board.rejectAll(_anyTask(taskSeed));
        rejected += 1;
    }

    function rawFinalize(uint256 callerSeed, uint256 taskSeed) external {
        vm.prank(_actor(callerSeed));
        board.finalize(_anyTask(taskSeed));
        finalized += 1;
    }

    function rawClaimSplit(uint256 callerSeed, uint256 taskSeed) external {
        vm.prank(_actor(callerSeed));
        board.claimSplit(_anyTask(taskSeed));
        splitsClaimed += 1;
    }

    function rawWithdraw(uint256 callerSeed) external {
        address a = _actor(callerSeed);
        uint256 amount = board.withdrawable(a);
        vm.prank(a);
        board.withdraw();
        withdrawals += 1;
        ethWithdrawn += amount;
    }
}

contract SwarmJobBoardInvariantTest is Test {
    SwarmJobBoard internal board;
    SwarmJobBoardHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        board = new SwarmJobBoard();
        handler = new SwarmJobBoardHandler(board);
        targetContract(address(handler));
    }

    /// @dev Everything the contract could still owe: open escrow, split shares not yet credited and
    ///      credited balances not yet withdrawn.
    function _liabilities() internal view returns (uint256 openRewards, uint256 unclaimedSplits, uint256 credited) {
        uint256 n = board.taskCount();
        uint256 actors = handler.actorCount();
        for (uint256 id = 1; id <= n; ++id) {
            SwarmJobBoard.Task memory t = board.task(id);
            if (t.status == SwarmJobBoard.Status.Open) {
                openRewards += t.reward;
            } else if (t.status == SwarmJobBoard.Status.Finalized) {
                for (uint256 i; i < actors; ++i) {
                    SwarmJobBoard.Submission memory s = board.submission(id, handler.actors(i));
                    if (s.revealed && !s.splitClaimed) unclaimedSplits += t.share;
                }
            }
        }
        for (uint256 i; i < actors; ++i) {
            credited += board.withdrawable(handler.actors(i));
        }
    }

    function invariant_balanceCoversEveryLiability() public view {
        (uint256 openRewards, uint256 unclaimedSplits, uint256 credited) = _liabilities();
        uint256 owed = openRewards + unclaimedSplits + credited;
        assertGe(address(board).balance, owed, "contract holds less than it owes");
        // With pull payments and no receive function the balance is exactly the liabilities.
        assertEq(address(board).balance, owed, "contract holds ETH nobody can claim");
    }

    function invariant_everyTaskIsOpenOrInOneTerminalState() public view {
        uint256 n = board.taskCount();
        for (uint256 id = 1; id <= n; ++id) {
            SwarmJobBoard.Task memory t = board.task(id);
            assertTrue(t.status != SwarmJobBoard.Status.None, "posted task has no status");
            if (t.status != SwarmJobBoard.Status.Finalized) {
                assertEq(t.share, 0, "share set outside finalize");
            } else if (t.revealedCount > 0) {
                assertEq(t.share, t.reward / t.revealedCount, "share is not reward / revealedCount");
            }
            assertLe(t.revealedCount, t.commitCount, "more reveals than commits");
        }
    }

    function invariant_inflowEqualsBalancePlusWithdrawn() public view {
        uint256 n = board.taskCount();
        uint256 inflow;
        for (uint256 id = 1; id <= n; ++id) {
            inflow += board.task(id).reward;
        }
        assertEq(inflow, address(board).balance + handler.ethWithdrawn(), "inflow != balance + withdrawn");
    }
}
