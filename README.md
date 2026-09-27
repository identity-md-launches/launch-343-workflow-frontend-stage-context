# Taskboard (TASK) and SwarmJobBoard

A Sepolia test toy. Posters escrow a small test-ETH reward for a task described off-chain, workers
commit and later reveal the hash of their work, and the poster pays one revealed worker or refunds
themself. If the poster never decides, the reward is split evenly among revealed workers.

**This is not a hiring or payment service.** A reward carries no off-chain obligation. The contract
never sees the work itself, only hashes. Rewards are Sepolia test ETH with no value. TASK is only the
launch token and is not used by the job board.

## Contracts

| Contract        | File                     | Constructor args | Owner / admin |
| --------------- | ------------------------ | ---------------- | ------------- |
| `LaunchToken`   | `src/LaunchToken.sol`    | none             | none          |
| `SwarmJobBoard` | `src/SwarmJobBoard.sol`  | none             | none          |

ABI exports live in `docs/abi/LaunchToken.json` and `docs/abi/SwarmJobBoard.json`.

### LaunchToken (Taskboard, TASK)

Fixed-supply ERC-20 with 18 decimals. Exactly 1,000,000,000 TASK (10^27 minor units) is minted to
`msg.sender` in the constructor, which under the project factory is the factory itself. There is no
mint, burn, owner, pause, blocklist, fee, hook or upgrade path. The contract imports nothing.

### SwarmJobBoard

No constructor arguments, no owner, no admin, no fees, no upgrade path, no oracle, no keeper. Plain
ETH sent to the contract reverts because it has no `receive` or `fallback`. Every payout is credited to
an internal balance and pulled with `withdraw()` (checks-effects-interactions, non-reentrant).

#### Parameters (constants)

| Constant        | Value        | Meaning                                              |
| --------------- | ------------ | ---------------------------------------------------- |
| `MIN_REWARD`    | 0.0001 ether | Smallest reward `post` accepts                       |
| `MIN_DURATION`  | 1 hour       | Deadline must be at least this far ahead             |
| `MAX_DURATION`  | 30 days      | Deadline must be at most this far ahead              |
| `REVEAL_WINDOW` | 1 day        | Reveal is open for this long after the deadline      |
| `DECISION_END`  | 7 days       | Poster decision closes this long after the deadline  |

#### Task lifecycle

For a task with deadline `D`:

| Phase    | Window                         | Who      | Calls                        |
| -------- | ------------------------------ | -------- | ---------------------------- |
| commit   | `now < D`                      | workers  | `commit(taskId, c)`          |
| reveal   | `D <= now < D + 1 day`         | workers  | `reveal(taskId, result, salt)` |
| decision | `D + 1 day <= now < D + 7 days`| poster   | `accept(taskId, worker)` or `rejectAll(taskId)` |
| timeout  | `now >= D + 7 days`            | anyone   | `finalize(taskId)`           |
| cancel   | any time while open and no one has committed | poster | `cancel(taskId)` |

Each task ends in exactly one of `Accepted`, `Rejected`, `Cancelled` or `Finalized`. Settlement
functions all require the task to be `Open`, so a second settlement of any kind reverts. `finalize`
is always reachable because nothing in it loops over submissions.

- `post(specHash, deadline)` payable. `msg.value >= 0.0001 ETH`, deadline in
  `[now + 1 hour, now + 30 days]`. Returns the task id (ids start at 1).
- `commit(taskId, c)`. One commitment per address per task. The poster may not commit. There is no
  cap on submissions. `c = keccak256(abi.encode(resultHash, salt, msg.sender, taskId))`, so a copied
  commitment can never be revealed by anyone but its author, on any other task.
- `reveal(taskId, resultHash, salt)` checks the commitment and increments `revealedCount`.
- `accept(taskId, worker)` credits the whole reward to a worker who revealed.
- `rejectAll(taskId)` credits the whole reward back to the poster.
- `cancel(taskId)` refunds the poster if nobody has committed yet.
- `finalize(taskId)` after the decision window: with `revealedCount > 0`, fixes
  `share = reward / revealedCount` and credits the remainder wei to the poster; with none, refunds the
  poster in full.
- `claimSplit(taskId)` after `finalize`: each revealed worker credits its share exactly once.
- `withdraw()` pays the caller's credited balance.

Views: `task(id)`, `taskCount()`, `submission(taskId, worker)`, `revealedCount(taskId)`,
`withdrawable(address)`.

Events: `Posted`, `Committed`, `Revealed(taskId, worker, resultHash)`, `Accepted`, `Rejected`,
`Cancelled`, `Finalized(taskId, share, revealedCount)`, `SplitClaimed`, `Withdrawn`.

## Assumptions and trust

- **The poster is trusted to judge fairly.** Work is judged off-chain. `rejectAll` is always open to
  the poster inside the decision window, so a poster can refuse every submission and take the reward
  back. Workers should treat a reward as a tip the poster may withhold, not as payment owed.
- **The split is a fallback, not a guarantee.** It only applies when the poster does nothing for the
  whole decision window. It can be diluted by sybil submitters: anyone can commit and reveal any hash
  from many addresses and take equal shares. Nothing on-chain checks that a revealed hash corresponds
  to real work.
- **Commit-reveal hides results, not participation.** A commitment leaks nothing about the result,
  but the fact that an address committed is public.
- **Time comes from `block.timestamp`.** A validator can nudge it by seconds. Windows are hours to
  days long, so this only matters exactly at a boundary.
- **Rounding favours the poster.** `share` rounds down; the remainder wei (at most
  `revealedCount - 1` wei) goes to the poster.
- **Unclaimed balances stay in the contract forever.** There is no sweep, and a worker who never
  calls `claimSplit` or `withdraw` simply leaves their share escrowed. A recipient that reverts on
  receiving ETH only blocks its own withdrawal.
- **The contract's ETH always equals its liabilities**: open rewards, unclaimed split shares and
  credited balances. Tests assert this as an invariant under time-warped fuzzing.

## Deployment

Deployment happens through the project factory using the manifest written by the separate manifest
step. This repository contains no deploy script, holds no keys and broadcasts nothing.

| Item                     | Value                                       |
| ------------------------ | ------------------------------------------- |
| Chain                    | Sepolia (11155111)                          |
| Launch token             | `LaunchToken`, no constructor args          |
| Application contracts    | `SwarmJobBoard`, `constructorArgs: []`      |
| Privileged addresses     | none                                        |
| Launch-token balance needed by the app at deploy | none              |
| Compiler                 | solc 0.8.26, optimizer on, 200 runs, `bytecode_hash = "none"`, EVM `cancun` |

The factory is `msg.sender` for both constructors. `LaunchToken` mints its supply to the factory,
which forwards it to the pool and reward distributor. `SwarmJobBoard` reads nothing from
`msg.sender` in its constructor and holds no TASK.

## Operational responsibilities

- **Posters** choose a deadline that gives workers time, watch the reveal window close, and then call
  `accept` or `rejectAll` before `deadline + 7 days`. If they miss the window, `finalize` splits the
  reward among revealed workers. They call `withdraw()` to collect refunds and remainder wei.
- **Workers** generate a fresh random salt, keep it until reveal (the page stores it in localStorage
  and shows it for backup), reveal inside `[deadline, deadline + 1 day)`, and after a `finalize` call
  `claimSplit` then `withdraw`. A lost salt means the commitment can never be revealed.
- **Anyone** can call `finalize` on an abandoned task once the decision window closes. No keeper is
  required; a task with no `finalize` call just stays open with its ETH escrowed.
- **Nobody** has an admin role. There is nothing to pause, upgrade, sweep or reconfigure.

## Building and testing

```sh
forge build
forge test
forge fmt --check
```

`foundry.toml` pins `solc = "0.8.26"`, `evm_version = "cancun"` and `bytecode_hash = "none"`. The
forge-std library is vendored as plain files under `lib/forge-std` (v1.9.6), so the build works
offline. Tests read no environment variables and pass in any order.

Test coverage highlights (`test/SwarmJobBoard.t.sol`, `test/SwarmJobBoardInvariant.t.sol`,
`test/LaunchToken.t.sol`):

- every phase boundary: commit at the deadline reverts, reveal at `deadline + 1 day` reverts,
  accept before `deadline + 1 day` reverts, accept or rejectAll at `deadline + 7 days` reverts
- wrong salt, wrong result, copied commitment and commitment reused on another task fail to reveal
- accept, rejectAll, cancel and finalize each exclude every other settlement
- claimSplit twice, by a committed-but-unrevealed worker, by a stranger or by the poster is refused
- remainder wei with two and three revealers
- cancel after a commit refused; cancel with no commits allowed even after the deadline
- reentrant `withdraw` is blocked and a reverting receiver only blocks itself
- 200 spam commitments do not stop a real worker from revealing or `finalize` from settling
- invariant, under random time warps and random actions: contract ETH >= (and ==) open rewards +
  unclaimed split shares + credited balances; total inflow == balance + withdrawn

Tests passing is not a security audit. The separate independent adversarial review should attack:
paying a reward twice (accept, rejectAll, finalize in any order, claimSplit replay), stealing a result
by copying a commitment, a poster accepting an unrevealed worker, split rounding, and reentrancy on
withdraw.

## Not in this assignment

The one-page website (static export with `index.html` in `dist/`), `launch.json`, source
publication, attestation and deployment are separate steps of the workflow.
