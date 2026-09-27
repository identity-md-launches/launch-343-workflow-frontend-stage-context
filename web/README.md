# Taskboard frontend

One static React + TypeScript page for the deployed Taskboard / SwarmJobBoard launch. Rewards use **Sepolia test ETH**. TASK is the separate launch token. This is a Sepolia test toy, **not a hiring or payment service**; rewards carry no off-chain obligation.

The poster is trusted to judge fairly and can reject all results. An equal split happens only when the poster does not decide, and sybil submitters can dilute that split. With no revealed workers, finalization refunds the poster. All payouts are credits followed by a separate withdrawal. The board has no owner, admin, fee, or upgrade path; plain ETH transfers to it revert.

## Install, build, and preview

Requires Node.js 22.12+ (validated with 24.9.0), npm, and the repository's pinned Git history. From the repository root:

```sh
npm ci --prefix web
npm run typecheck --prefix web
npm run build --prefix web
npm run verify --prefix web
npm run preview --prefix web
```

Open the preview URL printed by Vite. The publisher serves the committed `dist/` directly; no build or Node server is required in production. Vite uses `base: './'`, local bundles, and one page with hash anchors. `/preview/` subpath hosting was tested. Serve over HTTP(S); opening `index.html` with `file://` cannot fetch the manifest.

`npm run dev --prefix web` provides development hot reload. Its middleware serves the same existing `dist/imd-deployment.json` and ABI files; run the build once before developing if the export has been removed. Rebuild to include source changes in the production export.

## Deployment and configuration

`web/deployment/deployment.json` and `web/deployment/network.json` preserve the supplied handoffs. The source commit is `36bdc22d134b8233a118cfa98582661d0fa9c9be`. The builder reads `docs/abi/<Contract>.json` **from that Git commit**, preserves its raw JSON-array bytes in `dist/abi/`, and compares each canonical Keccak-256 ABI hash to the handoff. Canonicalization sorts object keys recursively, preserves array order, and hashes compact UTF-8 JSON. The deployed Solidity sources are unchanged.

`web/scripts/export.mjs` runs after Vite. It copies the exact contract set, identifiers, and network block into `dist/imd-deployment.json`, then inventories **every other file** with lowercase SHA-256 hashes. The manifest excludes itself. Additional handoff-derived fields (`walletAddChain`, `pool`, `token`, `deploymentBlocks`) support the wallet, pool, token labels, and event queries. `npm run verify` checks pinned ABI bytes/hashes, handoff equality, relative paths, inventory completeness, count, and size. Always rebuild after modifying an export asset; do not hand-edit the manifest.

The browser loads **only this manifest** for deployment addresses, network/RPC settings, ABI paths, and pool settings. `src/config.ts` verifies ABI hashes and defines clients; there is no independent runtime address map. Protocol interface definitions for Uniswap v4 / Permit2 live in `src/swap.ts`; implementation ABIs come from the manifest's files. No private credentials or WalletConnect project ID are present.

## Wallets, reads, and task flow

- Supports injected EIP-1193 browser wallets (`window.ethereum`), including wallet in-app browsers. Install/unlock a wallet, then connect. Reconnect requests access again; change accounts inside the wallet. WalletConnect is not configured because no public project ID was supplied.
- Public RPC endpoints are attempted in handoff order. After a read failure, a connected wallet on the right chain can select **Use wallet RPC**. Chain ID and nonempty deployed contract code are checked before actions become available. On unknown chain / code 4902, switching offers the exact supplied `wallet_addEthereumChain` parameters, then switches again.
- The board reads eight tasks per page, latest first; filters apply to the current page. Reads refresh every 30 seconds and after confirmed transactions. Eligibility uses the latest block timestamp, not the local display clock. Dates are displayed in the visitor's local timezone. Fresh account/network checks run before simulation and again before signing; data older than 90 seconds blocks signing.
- Post uses a specification hash and at least 0.0001 ETH. The text helper computes Keccak-256 of exact UTF-8 text; it does not upload the brief. The UI adds a small minimum-duration buffer (1.02 hours); the contract's minimum remains one hour and maximum 30 days.
- Select a task, enter a 32-byte result hash, then generate a salt with `crypto.getRandomValues`. Result hash, salt, and commitment are saved in localStorage, keyed by chain + board + wallet + task, **before** a commit request. Both values are visible and copyable. A checkbox requires an external backup acknowledgement. Clearing browser data loses the local backup. Restore the original values with the original wallet; they must match its on-chain commitment.
- Commit before the deadline; reveal during the following 24 hours. The poster decides during the next six days. Cancellation is allowed whenever an open task has zero commits, including after its deadline. After deadline + seven days anyone can finalize. A revealed worker can claim a finalized split once. **Withdraw** pulls all credited ETH for the connected wallet.
- **Load revealed workers** reads `Revealed` events from the deployment block in 10,000-block chunks. No backend or indexer is used. Results are loaded on request; RPC range/rate limits surface a retryable error rather than claiming a complete list. Before accepting, the worker's current submission is checked again. Acceptance/rejection/cancellation have an inline consequence confirmation.
- Every transaction is simulated, then signed by the visitor's wallet. The page reports checking, wallet confirmation, pending receipt, confirmed/reverted/rejected states, and a transaction explorer link. Receipt wait times out after two minutes; use that link to check a still-pending transaction before retrying. There is no transaction broadcasting in validation.

## TASK swaps and token controls

Swaps use the handoff's Uniswap v4 quoter, universal router, and Permit2 addresses. The attested native ETH/TASK pool uses its fee/tick spacing and zero hook. Non-native pairing disables this native-only swap UI with an explanation.

Quotes call `quoteExactInputSingle` with `simulateContract`. Slippage accepts 0.1–5% and rounds the minimum output down. Quotes expire after 60 seconds, and changing amount, direction, slippage, wallet, or chain clears the quote. The page shows the input, approximate rate, estimated output, minimum output, and gas caveat. Router execution uses command `0x10`, actions `0x060c0f`, and the encoded swap/settle/take parameters; it is simulated before signing. A swap has a 20-minute deadline.

ETH input sends the amount as value and needs no approval. TASK input requires explicit, separate steps: exact-amount ERC-20 approval to Permit2; exact-amount Permit2 router approval with a 30-minute expiry; then the swap. Allowances are read again after confirmation. The advanced section provides transfer, exact allowance/revocation, and `transferFrom` controls using the implementation ABI. Amounts reject excess precision instead of silently rounding. TASK decimals are read from the token.

## Validation and evidence

```sh
npm test --prefix web
# Install Chromium outside the submission. This example works on the worker:
PLAYWRIGHT_BROWSERS_PATH=/tmp/taskboard-browsers npm exec --prefix web -- playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/taskboard-browsers npm run test:browser --prefix web
node web/scripts/check-dev.mjs
node web/scripts/check-live.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/taskboard-browsers node web/tests/live-browser.mjs
```

The browser test owns a temporary foreground HTTP server and closes it and Chromium before exiting. It serves the actual export at `/preview/`, mocks wallet/RPC interactions, and saves evidence in `docs/evidence/`. The live scripts are read-only: they check real public RPC chain/code and real browser state loading. See [validation](../docs/VALIDATION.md), [design system](../docs/DESIGN.md), and [browser results](../docs/evidence/browser-results.json). Mocked transaction tests do not establish that live wallet signatures, liquidity, swaps, or settlement have succeeded on-chain. Those behaviors were not broadcast or tested with funds.

The pinned interface guide requested a root `DESIGN.md`; the explicit write budget permits only `web/**`, `dist/**`, and `docs/**`, so the design document is intentionally at `docs/DESIGN.md`.

## Submission budget

The only added ignore file is **`web/.gitignore`**, the explicitly allowed path. Its patterns exclude dependency/cache/test-output directories at every depth below `web/`. No root configuration, Solidity, existing ABI, library, or Git submodule is changed. Source, lockfile, production export, and evidence are included; `node_modules`, browser binaries, caches, tarballs, and temporary submission probes are excluded. The final measured export and bundle budget are recorded in `docs/evidence/submission-budget.json`.
