# Household workspace

`HouseholdWorkspace({ backend, onPendingChange? })` is the authenticated remote
collection workspace, mounted by `backend.api.generation` and scoped to
`.hh-workspace`. The parent owns auth, pairing, backups, and event sync; this
workspace never disposes the backend or imports native filesystem APIs.

## Components

| File                                                       | Responsibility                                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HouseholdWorkspace.tsx`                                   | Five-tab shell (`Collection`, `Import / save workbench`, `Observed trackers`, `Household trade`, `Capabilities / evidence`) and Save/Rollback/Rebase bar |
| `VaultPanel.tsx`                                           | 30-slot box grid (keyboard arrows, bank/box CRUD, UUID placement without overwriting occupied slots, unplaced list)                                      |
| `SearchPanel.tsx`                                          | Server-backed AND filter search (`q`, `tag`, `favorite`, `unplaced`, numeric `species`/`form`)                                                           |
| `RecordPanel.tsx`                                          | Selected Pokémon detail, OHPKM decoding, favorite/label tag editing, archival, and single-record export                                                  |
| `PokemonSummary.tsx`                                       | Shared Pokémon summary card and species/form resource label helper                                                                                       |
| `ImportPanel.tsx`                                          | Raw PKM/OHPKM upload (with PK4/PK5 hints) and complete-save slot inspection / COPY import                                                                |
| `TransferPanel.tsx`                                        | Save-slot withdrawal preview (`transfer_id`), explicit loss diagnostics/consent, validated artifact download, and UUID recovery/cancel                   |
| `TrackerPanel.tsx`                                         | Observed Pokédex/form/move/ability/ribbon trackers at pinned vault revision + historical Pokédex list                                                    |
| `TradePanel.tsx`                                           | Private household link trade rooms (join code, per-Pokémon offer custody, version-bound consent reset, confirm/cancel)                                   |
| `SupportPanel.tsx`                                         | Live `/api/v1/status` capabilities and checked-in engine evidence bounds                                                                                 |
| `workspace.tsx`, `model.ts`, `uploads.tsx`, `feedback.tsx` | Workspace state, unsaved-draft switch guards (`onPendingChange`), placement/rebase helpers, file limits, and diagnostic feedback                         |

## Core workflows

- **First Pokémon browser walkthrough (COPY only):**
  1. Open **Import / save workbench** (`ImportPanel`) and select a save file or PKM/OHPKM.
  2. Inspect occupied slots (up to 30 checked slots per request); source saves are never modified on upload.
  3. Select Pokémon and click **COPY** (`api.prepare` retains the request under uncertainty; committed imports survive later placement rollbacks).
  4. In **Collection** (`VaultPanel`), pick the unplaced Pokémon, click an empty 30-slot box position, and click **Save changes**.
- **Withdrawal Preview (`TransferPanel`):** Preparing a withdrawal preview marks
  that vault Pokémon as `Reserved`, temporarily locking it for 600 seconds
  until cancelled via a fresh backup or expiry, without modifying any 3DS save.
- **Tags & Favorites (`RecordPanel` & `SearchPanel`):** Toggle `favorite` or
  add up to 16 custom `tags` labels per Pokémon. Changes stage locally and are
  committed as metadata updates (`metadata_put`) when you click **Save changes**,
  making records searchable by label or favorite status.
- **Observed Trackers (`TrackerPanel`):** Browse revision-pinned `species`,
  `forms`, `moves`, `abilities`, and `ribbons` plus legacy `pokedex_history`.
  These track your observed household collection, **not** official HOME completion.
- **Link Trade Rooms (`TradePanel`):** Create a room or enter a join code to
  trade per-Pokémon custody using own-vault UUIDs—never whole-save sharing.
  Both participants see authoritative offers/confirmations, changing any offer
  resets `offer_version` consent, and WebSocket events invalidate room reads
  (with a 60-GET / >=10 s fallback poll while nonterminal).

## Safety & native-write limits

- **Draft, epoch & retry guards:** The workspace notifies its parent via
  `onPendingChange` to block switching servers or modes while unsent drafts,
  staged edits, uncertain commits, or unrecorded withdrawal transfers remain
  open. Session-epoch checks discard stale asynchronous responses after sign-out
  or account switches, a `401` immediately clears and unmounts private views,
  and uncertain commits replay the exact retained request so retries never
  double-apply. Definite `409` revision conflicts keep local edits intact and
  require clicking **Refresh server** and explicitly rebasing (record deletions
  must be rolled back and restaged rather than three-way rebased).
- **Loss policy & export fencing:** Conversions default to `allow_lossy: false`
  (returning `422` when data would be lost); explicit per-target consent is
  required for preview-only lossy downloads. Returned byte lengths, SHA-256
  digests, and original manifests are verified before any download starts, and
  changing the selected record, original artifact, target format, or lossy
  consent immediately invalidates any prior preview or consent state so stale
  previews cannot be downloaded.
- **Native writes disabled:** Physical save/3DS archive writes are **disabled in
  this workspace** regardless of server flags. Downloads are client-local copies
  only and never trigger `local_applied` or `finalize`. Mobile browsers and
  physical 3DS hardware remain unverified/blocked.

## Verification

Run from the parent repository root (compile WASM first if not yet generated):

```sh
pnpm --dir openhome wasm-compile-dev
pnpm --dir openhome test-household
pnpm --dir openhome typecheck
pnpm --dir openhome exec oxlint src/ui/household --type-aware --report-unused-disable-directives --max-warnings 0
pnpm --dir openhome exec oxfmt --check src/ui/household
```

`household.test.ts` wraps the `.tsx` journey suites for Vitest's `.test.ts`
matcher, exercising typed localhost HTTP fixtures and real WASM/PKM bytes.
Full-stack Rust-service, OCI, WebKit, and Tauri integration suites run in the
parent `tests/` directory.
