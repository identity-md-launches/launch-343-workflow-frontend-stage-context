# Frontend validation — Taskboard

Worker validation on 2026-09-27. These results are this worker's evidence, not independent certification or publication checks.

## Scope and assumptions

Implemented one Vite/React/TypeScript page for the two already deployed contracts. No contract, root configuration, deployment, publishing, IPFS pin, or site-name mutation was performed. `web/` contains source, package manifest, lockfile, build configuration, handoffs, and repeatable tests; `dist/` contains the production export; `docs/` contains design and validation evidence.

The explicit write scope overrides the conflicting request for root `DESIGN.md`: the implemented design document is `docs/DESIGN.md`. `web/.gitignore` is the only added ignore file and uses the assignment's explicit allowance. Injected browser wallets are supported; no WalletConnect project ID was supplied. Browser views are English/light theme. Screenshots of populated task lists and balances are **mock fixtures**, except `live-desktop.png`, which uses the real RPC and an unconnected wallet.

## Verification results

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript and production build | PASS | `npm run build --prefix web` runs `tsc --noEmit`, Vite, then the manifest generator; `evidence/build.log` |
| Unit tests | PASS, 13 tests | `npm test --prefix web`; `evidence/unit-tests.log` |
| Browser interactions | PASS, 17 scenarios | `PLAYWRIGHT_BROWSERS_PATH=/tmp/taskboard-browsers npm run test:browser --prefix web`; `evidence/browser-results.json` binds the tested asset hashes |
| Export integrity | PASS | `npm run verify --prefix web`; `evidence/export-verification.log` |
| Live public RPC chain/code | PASS, all three endpoints | `node web/scripts/check-live.mjs`; `evidence/live-rpc.json` |
| Real browser reads | PASS | `PLAYWRIGHT_BROWSERS_PATH=/tmp/taskboard-browsers node web/tests/live-browser.mjs`; `evidence/live-browser.json`, `evidence/live-desktop.png` |
| Development manifest/ABI serving | PASS | `node web/scripts/check-dev.mjs`; `evidence/dev-server.json` |
| Source/path/artifact/bundle budget | PASS | `evidence/submission-budget.json` |

The provided browser MCP was attempted and returned “Browser chrome-for-testing is not installed” for `/home/seat/.cache/ms-playwright/chromium-1246/chrome-linux64/chrome`. Its missing installation path is outside the write scope. Actual rendered verification instead used Playwright 1.58.2 with Chromium installed under `/tmp/taskboard-browsers`. Each test process owns and closes its foreground preview and browser. No browser check was inferred from source alone.

An initial Python urllib probe received HTTP 403 from all configured RPCs. Subsequent Node fetch and Chromium probes succeeded. The recorded Node check confirmed chain ID **11155111**, LaunchToken code **1,362 bytes**, and SwarmJobBoard code **4,775 bytes** on each endpoint. The real browser loaded the board and live task count (zero at the observed block), with no page/console errors, failed requests, or desktop overflow. These are observations at the recorded time, not promises of future RPC availability.

### Interaction coverage

Tests serve the actual built files at `/preview/` and use real viem ABI encoding/decoding with mocked EIP-1193 wallet and JSON-RPC replies. No test has a private key or sends a network transaction. Covered:

- Disconnected/no-wallet states, initial disabled actions, wallet connection, wrong network, exact add-chain parameters after 4902, account/network changes, simulation failure, and wallet rejection.
- Posting validation, keyboard submission, correct payable value, confirmation state and refresh.
- Random salt generation, persisted visible backup before signing, backup acknowledgement, reload preservation, wrong-salt rejection, valid restore, commit/reveal binding and phase eligibility.
- `Revealed` event lists, poster acceptance with inline consequence confirmation, reject all, cancel, finalize, claim split, and withdraw. Claimed/zero-balance controls become disabled.
- Native quote without sending a transaction; V4 router target, command/actions, minimum receive and value; separate exact-amount token/Permit2 approval steps for a TASK sale, with all addresses read from the manifest.
- TASK transfer, zero allowance revocation and delegated transfer controls.
- localStorage failure, missing deployed code, RPC failure/retry recovery, and tampered ABI rejection.
- Unit tests independently check exact phase boundaries, cancellation after a deadline with no commits, replay-related eligibility, sender/task binding, random salt storage, precision rejection, slippage rounding and swap tuple decoding.

This does not test Solidity behavior independently. The protected definitions and deployed source were read; Solidity was preserved, and no Foundry run is claimed for this frontend assignment. Mocked transactions do not prove that a real wallet will sign, gas will be affordable, a pool has executable liquidity, or live task settlement will succeed.

## Better Interface review

The pinned workflow and core principles in all six domains were read and applied during implementation. The final design document was extracted from the implemented CSS/components. Coverage is consolidated below.

| Domain | Coverage | Evidence and limitations |
| --- | --- | --- |
| Accessibility | Checked | Native labels/buttons/disclosures, meaningful headings and landmarks, focus outline, skip link, post flow by keyboard, live status/errors, invalid-field focus, control names, disabled prerequisites, backup checkbox, reduced motion. Axe WCAG 2/2.1 A/AA scan: **0 violations**, 29 passing rules. Screen-reader and physical-device sessions were not performed. |
| Layout | Checked | Screenshots and document-width checks at **1440×1050, 820×1100, 390×1000, 320×960**; long address/salt backup at 320px; 200% root text enlargement at 320px after repair. No horizontal document overflow in final tests. Browser-native zoom and RTL/pseudo-localization were not tested. |
| Writing | Checked | Action-specific labels, explicit test-ETH/TASK distinction, trusted-poster and sybil limitations, visible backup instructions, transaction consequences, empty-state next action and recovery controls. English only. |
| Typography | Checked | System serif/sans/monospace roles, 16px form inputs, selectable wrapping hashes, tabular numbers, 12px metadata floor, desktop/mobile heading and caption wrapping. Font availability relies on the platform; no external-font loading claim. |
| Colors | Checked | Semantic source tokens plus actual computed background/foreground pairs. Muted/page 5.50:1, muted/soft 5.27:1, muted/white 5.98:1, primary text/fill 9.58:1. `evidence/contrast.json`. Dark theme not applicable. Not every state/pair was separately measured. |
| UI | Checked | Empty/loading/disabled/selected/error/confirmed states, inline finality confirmation, visible native disclosures, borders/surfaces, button hover/press and reduced-motion rules. Keyboard focus screenshots were visually inspected. No modal focus trap, entrance animation or theme-switch behavior exists; those checks are not applicable. Animation-panel slow replay was not performed. |

Axe's remaining incomplete contrast items are decorative, `aria-hidden` glyphs (“◉” beside the network name and “↳” beside the faucet description). They carry no independent information and are not text-contrast compliance claims. Full machine output is in `evidence/accessibility.json`; passing the automated scan is not a claim of complete accessibility conformance.

### Findings, fixes, and rechecks

| Severity / domain | Final source location | Finding and correction | Recheck |
| --- | --- | --- | --- |
| HIGH / UI, data retention | `web/src/TaskPanel.tsx:61` | Poll-driven submission reads originally shared an effect that reset unsaved result text. Separated wallet/task backup loading from refreshed submission reads. | Browser commit/backup/reload/reveal flow passed; source confirms polling no longer resets the form. |
| MEDIUM / accessibility | `web/src/TokenPanel.tsx:210` | A wrapping select label included option text; the exact “Direction” label could not be found by the browser interaction test. Switched to an explicit `htmlFor`/`id` label. | Both swap directions passed with an exact accessible-label query. |
| MEDIUM / layout | `web/src/styles.css:1101` | At 320px with 200% root text, intrinsic sidebar widths and the section-header action widened the document. Added shrinking grid tracks/min-width and wrapping headers/faucet groups. | Final document-width assertion passed, including the long backup. |
| MEDIUM / accessibility | `web/src/App.tsx:224` | Axe identified `aria-label` on a generic filter div as requiring review. Added the appropriate `group` role. | Repeated scan has no ARIA incomplete items or violations. |
| MEDIUM / accessibility | `web/src/App.tsx:26` | Post errors did not direct keyboard users to the invalid field. Added invalid-field tracking, descriptions, focus, and clearing feedback when the value changes. | Invalid specification and keyboard post tests passed. |
| LOW / typography | `web/src/styles.css:158` | Early screenshots showed several 10–11px captions. Raised them to a 12px floor. | Final desktop/mobile screenshots inspected, no clipping found. |
| LOW / UI | `web/src/styles.css:423` | An empty transaction live region rendered a colored strip. Kept the live region but removed its empty-state background. | Final live desktop screenshot inspected. |
| MEDIUM / amount handling | `web/src/model.ts:130` | Library decimal parsing can round excess precision. Added strict nonnegative decimal validation before parsing. | Unit tests reject excess precision, signed/exponent/non-numeric input. |

Earlier failed browser runs were repaired and rerun; their overwritten failure images were removed. Two failures were test-harness assumptions (a cleared post form after reload, and checking an internal RPC detail instead of the visible retry state), not production regressions. The retained report contains the final passing run only.

## Visual evidence

- `evidence/live-desktop.png`: real, disconnected Sepolia board.
- `evidence/desktop.png`, `intermediate.png`, `mobile.png`, `narrow.png`: populated **mock** board at the four widths.
- `evidence/mobile-viewport.png`: legible mobile viewport capture.
- `evidence/narrow-backup.png`: long private backup and lifecycle controls at 320px, using a test wallet/salt.
- `evidence/keyboard-focus.png`, `keyboard-post.png`: skip-link and posting focus states.
- `evidence/empty.png`: mocked empty-board state.

## Completion and remaining limits

Complete for the implemented frontend and local validation within the permitted source/export/documentation paths. The root-design-file request is fulfilled at the allowed documentation path because the explicit scope takes priority. The requested Git commit is blocked by the worker filesystem: `git add -- web dist docs` returned `Unable to create .git/index.lock: Read-only file system`. No changes were staged or committed in this checkout. All source/export/evidence files are ready for the publisher to collect together; a disposable scratch snapshot was used to verify the bundle budget without changing this checkout’s Git metadata.

Untested: real wallet extension/in-app-wallet signatures, live ETH/TASK transfers/swaps, live commit/reveal/settlement transactions, adversarial RPCs, browser-native zoom, screen readers, physical mobile devices, Safari/Firefox, and future long-range event provider limits. No external messages, contract deployments, site publication, URLs or CIDs were produced. Subsequent control-plane checks remain separate from this worker's results.
