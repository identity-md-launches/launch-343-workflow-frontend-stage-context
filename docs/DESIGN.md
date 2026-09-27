# Taskboard design system

## Overview

A compact, light interface for a Sepolia experiment in collaborative work. A serif headline introduces the board, while neutral sans-serif controls keep task operations readable. The board occupies the wider desktop column; posting and the separate TASK swap panel occupy the narrower column. On smaller screens the same DOM order becomes a single column. These are implemented choices, not a separately approved brand system.

Source of truth: `web/src/styles.css`, `web/src/App.tsx`, `web/src/TaskPanel.tsx`, and `web/src/TokenPanel.tsx`. All assets are code-native; there are no remote fonts, stock images, or icon dependencies. Root `DESIGN.md` is outside the assignment's overriding write budget, so this document lives under `docs/`.

## Colors

All semantic tokens are defined in `:root` in `web/src/styles.css` and use sRGB hex notation. There is one light theme.

| Token | Value | Role |
| --- | --- | --- |
| `--page` | `#f5f6f0` | Page and inactive control background |
| `--surface` | `#ffffff` | Panels, inputs, neutral buttons |
| `--text` | `#253c31` | Headings, body, primary values |
| `--muted` | `#58675d` | Supporting text, labels, metadata |
| `--line` | `#d9dfd3` | Structural borders and separators |
| `--input-border` | `#889585` | Visible input and button boundaries |
| `--accent` | `#2d4939` | Links and primary button fill |
| `--accent-hover` | `#203729` | Primary hover fill |
| `--accent-text` | `#f5ffe7` | Text on primary buttons |
| `--soft` | `#edf3e3` | Posting panel, selected filters, backup surface |
| `--lime` | `#d6ef98` | Text selection background |
| `--error` | `#963b2c` | Error text |
| `--error-bg` | `#fff1ea` | Connection error surface |
| `--focus` | `#476924` | Three-pixel keyboard focus outline |

Measured rendered text contrast: muted/page **5.50:1**, muted/soft **5.27:1**, muted/surface **5.98:1**, accent-text/accent **9.58:1**. Exact computed pairs and methodology are in `docs/evidence/contrast.json` and `web/tests/browser.mjs`. These measurements cover those pairs, not every possible state. Status also has text; color never carries task phase by itself.

## Typography

- UI/body: `Arial, Helvetica, sans-serif`, 16px root, unitless 1.5 line height. Supporting copy uses 13px (`--text-sm`) with 1.6 line height; small metadata and eyebrows use 12px. Inputs stay 16px at all widths.
- Display headline: `Georgia, 'Times New Roman', serif`, weight 400, `clamp(2.6rem, 5.5vw, 4.5rem)`, letter spacing `-.055em`; at 430px and below it is 2.65rem. The explanatory section uses Georgia at 2rem, reduced to 1.7rem on narrow screens.
- Headings: `--text-h2: 1.5rem`, `--text-h3: 1rem`; standard heading line height 1.15 and h3 1.4. The post panel uses 1.6rem and token panel 1.375rem h2 variants.
- Codes/hashes: `ui-monospace, SFMono-Regular, Consolas, monospace`, 13px, `overflow-wrap:anywhere`. Full values remain selectable. Hash inputs scroll natively; visible backup hashes wrap rather than truncate.
- Numeric values use `font-variant-numeric: tabular-nums`. Eyebrows have `.12em` tracking and CSS uppercase. Headings use `text-wrap:balance`; paragraphs use `text-wrap:pretty`.
- No font files are downloaded. CSS requests weights 400–700; system font fallback determines available faces. There is no claim that a particular proprietary font loaded. Font smoothing is set once at the root.

## Layout

The header and main content have a 1240px maximum width with 40px horizontal padding. Main desktop grid: `minmax(0,1fr) 350px`, gap 28px. Panels generally use 28px padding. Controls group with 8–12px internal gaps; larger groups use 20–40px spacing. Text and hash containers are allowed to shrink; no page-level clipping hides overflow.

- At **1020px**: outer padding becomes 28px, sidebar 320px, grid gap 20px, panel padding 22px. The timeline and explanatory list simplify where columns no longer fit.
- At **780px**: outer padding 20px; one content column; the balance summary is two columns with withdrawal spanning a separate row. The secondary hero note disappears. The header wraps. The aside uses `minmax(0,1fr)` to avoid intrinsic overflow.
- At **430px**: outer padding 16px, panel padding 20px, header wallet row expands across the width; task facts, backup fields and timeline collapse; section headings and the faucet note wrap. Hashes remain visible.

Rendered checks covered 1440, 820, 390 and 320 CSS pixels, plus 200% root text enlargement at 320px. No horizontal document overflow occurred in the final checks, including the visible salt backup. Text enlargement is not a claim about browser-native zoom. RTL/localized variants were not implemented or certified.

## Elevation & depth

The interface is flat: white and pale-green surfaces, structural one-pixel borders, no box shadows. The selected task gets a soft background and a visible expanded state. Disclosure uses native `details`/`summary`, and destructive task decisions expand an inline confirmation instead of opening a modal. Nothing overlays the page except the keyboard-only skip link.

## Shapes

Panels use `--radius:16px`. Standard inputs/buttons/notices use 8px, backup/confirmation boxes 10px, badges 6px, and the empty-state mark 14px. Borders mark structure or a usable control boundary. The brand mark is three small CSS bars; arrows and other symbols are text glyphs, with decorative glyphs hidden from accessibility names.

## Components

| Pattern | Source | Behavior and reuse |
| --- | --- | --- |
| Header + wallet status | `App.tsx`, `.site-header`, `.wallet-controls` | Connected account abbreviation with full value in deployment disclosure; explicit wrong-network switch and missing-wallet error |
| Summary + withdrawal | `App.tsx`, `.stats` | Contract count, native balance, credited ETH; Withdraw disabled for zero credit or unmet prerequisites |
| Panel | `.panel`, `.section-heading` | White structure with heading and optional secondary action; `.post-panel` uses soft fill |
| Task row | `App.tsx`, `.task-row` | A real button with `aria-expanded`; task ID, reward, counts, phase, and local date; selected background |
| Task details | `TaskPanel.tsx` | Full hashes, timeline, private backup, worker event list, phase-aware settlement controls; `DateText` renders semantic dates |
| Fields and actions | Native labels, inputs, buttons; `.two-fields`, `.actions` | Visible labels, 16px inputs, meaningful units; disabled/loading states; invalid post field receives focus and descriptive error |
| Private backup | `TaskPanel.tsx`, `.backup`, `.check` | Selectable full result/salt, copy action, explicit external-backup acknowledgement, validated restore |
| Confirmation | `TaskPanel.tsx`, `.confirmation` | States recipient, amount and finality; explicit confirm and “Keep task open” actions |
| TASK panel | `TokenPanel.tsx` | Native direction select, amount/slippage, expiring quote, distinct approval steps, advanced token actions |
| Transaction feedback | `useBoard.ts`, `App.tsx`, `.transaction` | Persistent text status/error and explorer link; empty live region has no visible background |
| Buttons | `.primary`, `.connect`, `.quiet`, default button | Filled primary emphasis; neutral secondary controls; most targets 44px high, dense filters/pagination 40px; 3px focus outline offset 4px |

Native buttons, links, fields, checkbox and disclosures support keyboard interaction. Skip-to-content and post-by-keyboard were exercised and screenshot evidence was inspected. Motion is a 120ms background/color/transform transition with `.96` press scale, enabled only under `prefers-reduced-motion:no-preference`. Reduced-motion behavior was checked. Forced-color overrides use system `Highlight` / `ButtonText`; that mode was source-reviewed, not visually tested.

## Do's and don'ts

- Start another section with `.panel` and `.section-heading`; keep long content inside a shrinking grid column.
- Reuse semantic color tokens and native controls. Reserve the filled treatment for the current primary entry/action and keep peers neutral.
- Keep chain, token and monetary units explicit. Preserve phase/eligibility restrictions and the simulation-before-signing flow.
- Preserve full hashes and salt backups; do not shorten the only copy of a critical value.
- Add pages only with explicit exported routes or hash navigation. Continue to load deployment data from the one runtime manifest.
- Do not add external fonts, heavy illustrations, gradients, overlays or new themes to imitate this design. They are not part of its implemented system.

Design guidance: Jakub Krehel's Better Interface, MIT, pinned commit `267330e1adfc66a718fb65fa6918c1f06d0a689e` ([source](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-interface)). Documentation organization follows Paul Bakaus's Impeccable reference, Apache-2.0, pinned commit `9d715cc4f5564a990ca8345abfdd5df6dc9b41c8` ([source](https://github.com/pbakaus/impeccable/blob/9d715cc4f5564a990ca8345abfdd5df6dc9b41c8/skill/reference/document.md)). The pinned reference was used locally; upstream content was not fetched or redistributed.
