# Household workspace

`HouseholdWorkspace({ backend, onPendingChange? })` is the authenticated remote
collection UI. The parent owns connection/authentication, account/pairing,
backups/folder interoperability, and the backend's event lifecycle. This
workspace never disposes the parent backend or imports native filesystem APIs.
CSS is confined to `.hh-workspace`.

## Working workflows

- Exactly 30 slots per box, explicit bank/box creation/rename/empty deletion,
  UUID-based selection and placement across boxes, and a separate unplaced list.
  Occupied destinations never overwrite another record.
- Local SDK staging, aggregate Save, local rollback, exact uncertain-save replay,
  and explicit three-way rebase. Concurrent edits to the same field/placement
  stop visibly. Unrelated current content and legacy Pokédex history survive.
- Real canonical binary OHPKM decoding, distinct server UUID/OpenHome identity,
  resource names/icons, observations, persistent `metadata_put` favorites/labels,
  API-backed search, and revision-pinned metadata trackers. These mean observed
  owned collection, **not official HOME completion**.
- Binary PKM/OHPKM upload/drop with limits, SHA validation and explicit ambiguous
  PK4/PK5 hints. COPY imports retain one prepared request during uncertainty.
  An acknowledged COPY is independent of later placement rollback.
- Complete-save inspection pages retain and re-upload the exact same source.
  Only checked occupied slots (at most 30) are imported, with exact expected PKM
  digests and null destinations. The complete source remains owner-private.
- Exact per-Pokémon original, canonical OHPKM, and game-PKM conversion export.
  Returned length/SHA are checked; original manifests must match. Conversion
  starts with loss forbidden; explicit per-target consent permits a diagnostic
  preview before a separate download.
- Withdrawal preview through the frozen transfer API, stable transfer UUID,
  explicit conversion consent/diagnostics, actual empty inspected destination,
  validated prepared/original downloads, owner-scoped recovery by UUID, and
  cancellation only after re-reading matching current-original and backup files.
- Private trade creation/join, own-UUID offers, both authoritative participant
  offers/confirmations, current trade ETag plus vault revision, version-bound
  consent reset on changed offers, confirmation/cancel and refresh. The existing
  backend event sequence invalidates room reads; fallback polling is bounded to
  60 GETs at intervals of at least 10 seconds, only while a room is nonterminal.

## Safety and integration

Mount by `backend.api.generation` (the workspace also enforces this). Epoch
guards reject old callbacks and credential loss unmounts all private content.
`onPendingChange` reports active work, retained uncertain requests and unsent
form/offer drafts. A prepared transfer also guards navigation until its recovery
UUID is explicitly recorded. The parent should block mode/profile switching
while this guard or `backend.connection.editing/uncertain` is true.

Retained PKM/save uploads, format/digest inputs, save selections, unsent join/search
forms, export choices/consent, and transfer lookup/verification inputs register
their drafts before any API submission. Explicit discard controls clear client
drafts; they never undo acknowledged COPY imports or cancel server transfers.
Empty/default forms do not hold the guard.

Room reads, errors, polling and in-flight indicators belong to a room UUID,
credential generation and selection epoch. Only explicit create/join receipts
select another room; a superseded read cannot replace its room or invitation.
Export previews/downloads similarly belong to a record and monotonic intent
token plus the exact artifact/target/consent controls. Changing controls revokes
that token even if the user later returns to identical values. Delayed responses
are checked after awaits and byte validation and cannot restore old consent.

All durable new intents use `api.prepare`; uncertainty retries the retained
request without replacing its key/body. No automatic mutation reapply, private
durable browser cache, new SDK, relaxed schema guard, or foreign-vault selector
exists. Definite stale revision recovery is explicit; record deletions must be
rolled back/restaged rather than three-way rebased.

Native writes are **disabled in this workspace**, regardless of a server feature
flag. A download is not proof of backup/write/reopen and never triggers
`local_applied` or `finalize`. Those stages require separately certified tooling
and real hardware evidence. The frozen transfer DTO has no save-specific loss
diagnostic array; the UI labels its standalone format-conversion preview as
such, rather than inventing save diagnostics. Server support comes from actual
Status; the checked-in scope notes explicitly bound variants and fixture tiers.

## Checks and remaining evidence

```sh
pnpm exec vitest run src/ui/household
pnpm exec tsc --pretty false
pnpm exec oxlint src/ui/household --type-aware --report-unused-disable-directives --max-warnings 0
pnpm exec oxfmt --check src/ui/household
```

Use the task's pinned pnpm 12.4.1 ELF and existing generated WASM. The small
`household.test.ts` entry imports JSX journey tests because the unchanged shared
Vitest include selects `.test.ts`.

Tests exercise user clicks against a typed localhost HTTP fixture and real
nonempty upstream PKM/OHPKM bytes/WASM. Inspection/transfer responses are
transport fixtures, **not the real engine or Rust-service E2E**. Browser/native
downloads are not physical-save verification. Actual service wiring, OCI/LTS,
desktop-shell/mobile interaction, hardware gates and two non-author reviews
plus RUGGED remain separate parent-owned acceptance evidence.
