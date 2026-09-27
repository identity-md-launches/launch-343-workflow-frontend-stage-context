// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SwarmJobBoard
/// @notice A Sepolia test toy: posters escrow a test-ETH reward for a task, workers commit and later
///         reveal the hash of off-chain work, and the poster either pays one revealed worker or
///         refunds themself. If the poster never decides, the reward is split evenly among revealed
///         workers. This is not a hiring or payment service and a reward carries no off-chain
///         obligation.
/// @dev No constructor arguments, no owner, no admin, no fees, no upgrade path. Plain ETH sent to the
///      contract reverts because there is no receive or fallback function. Every payout is credited to
///      an internal balance and pulled with withdraw() (checks-effects-interactions, non-reentrant).
///
///      Timeline for a task with deadline D:
///        - commit:   block.timestamp <  D
///        - reveal:   D <= block.timestamp < D + 1 day
///        - decision: D + 1 day <= block.timestamp < D + 7 days   (accept / rejectAll, poster only)
///        - finalize: block.timestamp >= D + 7 days                (anyone)
///        - cancel:   any time while the task is open and nobody has committed (poster only)
///
///      Each task ends in exactly one of Accepted, Rejected, Cancelled or Finalized.
contract SwarmJobBoard {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    enum Status {
        None,
        Open,
        Accepted,
        Rejected,
        Cancelled,
        Finalized
    }

    struct Task {
        address poster;
        uint64 deadline;
        Status status;
        bytes32 specHash;
        uint256 reward;
        uint256 commitCount;
        uint256 revealedCount;
        /// @dev Per-worker share fixed by finalize(); zero until then.
        uint256 share;
    }

    struct Submission {
        bytes32 commitment;
        bytes32 resultHash;
        bool revealed;
        bool splitClaimed;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    uint256 public constant MIN_REWARD = 0.0001 ether;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant REVEAL_WINDOW = 1 days;
    uint256 public constant DECISION_END = 7 days;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    uint256 private _taskCount;
    mapping(uint256 => Task) private _tasks;
    mapping(uint256 => mapping(address => Submission)) private _submissions;
    mapping(address => uint256) private _withdrawable;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event Posted(uint256 indexed taskId, address indexed poster, bytes32 specHash, uint256 reward, uint64 deadline);
    event Committed(uint256 indexed taskId, address indexed worker, bytes32 commitment);
    event Revealed(uint256 indexed taskId, address indexed worker, bytes32 resultHash);
    event Accepted(uint256 indexed taskId, address indexed worker, uint256 reward);
    event Rejected(uint256 indexed taskId, uint256 reward);
    event Cancelled(uint256 indexed taskId, uint256 reward);
    event Finalized(uint256 indexed taskId, uint256 share, uint256 revealedCount);
    event SplitClaimed(uint256 indexed taskId, address indexed worker, uint256 share);
    event Withdrawn(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error RewardTooSmall();
    error DeadlineOutOfRange();
    error TaskNotOpen();
    error NotPoster();
    error PosterCannotCommit();
    error AlreadyCommitted();
    error EmptyCommitment();
    error NotCommitted();
    error AlreadyRevealed();
    error BadReveal();
    error CommitPhaseOver();
    error NotInRevealWindow();
    error NotInDecisionWindow();
    error DecisionWindowStillOpen();
    error WorkerNotRevealed();
    error HasCommits();
    error NotFinalized();
    error SplitAlreadyClaimed();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    // ---------------------------------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------------------------------

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------------------------------------
    // Poster actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Post a task and escrow its reward.
    /// @param specHash Hash of the off-chain task description; the contract never sees the spec.
    /// @param deadline End of the commit phase. Must lie in [now + 1 hour, now + 30 days].
    /// @return taskId The new task's id (ids start at 1).
    function post(bytes32 specHash, uint64 deadline) external payable returns (uint256 taskId) {
        if (msg.value < MIN_REWARD) revert RewardTooSmall();
        if (deadline < block.timestamp + MIN_DURATION || deadline > block.timestamp + MAX_DURATION) {
            revert DeadlineOutOfRange();
        }
        taskId = ++_taskCount;
        Task storage t = _tasks[taskId];
        t.poster = msg.sender;
        t.deadline = deadline;
        t.status = Status.Open;
        t.specHash = specHash;
        t.reward = msg.value;
        emit Posted(taskId, msg.sender, specHash, msg.value, deadline);
    }

    /// @notice Pay the whole reward to one worker who revealed. Poster only, inside the decision window.
    function accept(uint256 taskId, address worker) external {
        Task storage t = _openTaskOf(taskId);
        _requireDecisionWindow(t);
        if (!_submissions[taskId][worker].revealed) revert WorkerNotRevealed();
        t.status = Status.Accepted;
        _withdrawable[worker] += t.reward;
        emit Accepted(taskId, worker, t.reward);
    }

    /// @notice Refund the reward to the poster. Poster only, inside the decision window.
    function rejectAll(uint256 taskId) external {
        Task storage t = _openTaskOf(taskId);
        _requireDecisionWindow(t);
        t.status = Status.Rejected;
        _withdrawable[t.poster] += t.reward;
        emit Rejected(taskId, t.reward);
    }

    /// @notice Cancel a task nobody has committed to and refund the reward. Poster only.
    function cancel(uint256 taskId) external {
        Task storage t = _openTaskOf(taskId);
        if (t.commitCount != 0) revert HasCommits();
        t.status = Status.Cancelled;
        _withdrawable[t.poster] += t.reward;
        emit Cancelled(taskId, t.reward);
    }

    // ---------------------------------------------------------------------------------------------
    // Worker actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Commit to a result before the deadline. One commitment per address; the poster may not commit.
    /// @param commitment keccak256(abi.encode(resultHash, salt, msg.sender, taskId)). Binding the caller
    ///        and task id means a copied commitment can never be revealed by anyone else.
    function commit(uint256 taskId, bytes32 commitment) external {
        Task storage t = _tasks[taskId];
        if (t.status != Status.Open) revert TaskNotOpen();
        if (block.timestamp >= t.deadline) revert CommitPhaseOver();
        if (msg.sender == t.poster) revert PosterCannotCommit();
        if (commitment == bytes32(0)) revert EmptyCommitment();
        Submission storage s = _submissions[taskId][msg.sender];
        if (s.commitment != bytes32(0)) revert AlreadyCommitted();
        s.commitment = commitment;
        t.commitCount += 1;
        emit Committed(taskId, msg.sender, commitment);
    }

    /// @notice Reveal a committed result hash during the reveal window.
    function reveal(uint256 taskId, bytes32 resultHash, bytes32 salt) external {
        Task storage t = _tasks[taskId];
        if (t.status != Status.Open) revert TaskNotOpen();
        if (block.timestamp < t.deadline || block.timestamp >= t.deadline + REVEAL_WINDOW) revert NotInRevealWindow();
        Submission storage s = _submissions[taskId][msg.sender];
        if (s.commitment == bytes32(0)) revert NotCommitted();
        if (s.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(resultHash, salt, msg.sender, taskId)) != s.commitment) revert BadReveal();
        s.revealed = true;
        s.resultHash = resultHash;
        t.revealedCount += 1;
        emit Revealed(taskId, msg.sender, resultHash);
    }

    /// @notice After finalize(), each revealed worker credits its equal share exactly once.
    function claimSplit(uint256 taskId) external {
        Task storage t = _tasks[taskId];
        if (t.status != Status.Finalized) revert NotFinalized();
        Submission storage s = _submissions[taskId][msg.sender];
        if (!s.revealed) revert WorkerNotRevealed();
        if (s.splitClaimed) revert SplitAlreadyClaimed();
        s.splitClaimed = true;
        _withdrawable[msg.sender] += t.share;
        emit SplitClaimed(taskId, msg.sender, t.share);
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Settle a task whose poster never decided. Anyone, at or after deadline + 7 days.
    /// @dev With revealed workers the share is reward / revealedCount; the remainder wei goes to the
    ///      poster. With none, the whole reward is refunded to the poster. Nothing here loops, so the
    ///      number of submissions never affects reachability.
    function finalize(uint256 taskId) external {
        Task storage t = _tasks[taskId];
        if (t.status != Status.Open) revert TaskNotOpen();
        if (block.timestamp < t.deadline + DECISION_END) revert DecisionWindowStillOpen();
        t.status = Status.Finalized;
        uint256 n = t.revealedCount;
        if (n > 0) {
            uint256 share = t.reward / n;
            t.share = share;
            _withdrawable[t.poster] += t.reward - share * n;
            emit Finalized(taskId, share, n);
        } else {
            _withdrawable[t.poster] += t.reward;
            emit Finalized(taskId, 0, 0);
        }
    }

    /// @notice Pull everything credited to the caller.
    function withdraw() external nonReentrant {
        uint256 amount = _withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        _withdrawable[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function task(uint256 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function taskCount() external view returns (uint256) {
        return _taskCount;
    }

    function submission(uint256 taskId, address worker) external view returns (Submission memory) {
        return _submissions[taskId][worker];
    }

    function revealedCount(uint256 taskId) external view returns (uint256) {
        return _tasks[taskId].revealedCount;
    }

    function withdrawable(address account) external view returns (uint256) {
        return _withdrawable[account];
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _openTaskOf(uint256 taskId) private view returns (Task storage t) {
        t = _tasks[taskId];
        if (t.status != Status.Open) revert TaskNotOpen();
        if (msg.sender != t.poster) revert NotPoster();
    }

    function _requireDecisionWindow(Task storage t) private view {
        uint256 start = uint256(t.deadline) + REVEAL_WINDOW;
        uint256 end = uint256(t.deadline) + DECISION_END;
        if (block.timestamp < start || block.timestamp >= end) revert NotInDecisionWindow();
    }
}
