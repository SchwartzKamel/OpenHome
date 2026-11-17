# Household connection controls

`src/ui/App.tsx` mounts `src/core/remote/entry.tsx`. Disconnected browsers load
only the chooser, not the desktop provider graph, backend controller, household
workspace or folder tooling. **Connect later** remains available without a
network request. An explicit connection loads `ConnectionRoot`, then
`RemoteSession`; only authenticated sessions load the real
`@openhome-ui/household/HouseholdWorkspace`.

The original desktop provider tree, keyboard/menu handlers and 120-slot screens
are preserved in the lazy `LocalWorkspace`. Automatic local mode and the chooser
use the actual Tauri check and original lazy singleton. Browser mode does not
imitate filesystem access or send client paths to the service.

## Accounts and safe switching

- Saved profiles contain **only** `name` and normalized HTTP(S) `origin`, under
  `openhome.server-profiles.v1`. Credentials, password fields, setup secrets,
  pairing codes and retained requests are memory-only.
- HTTP displays an unencrypted-LAN warning and requires an explicit checkbox
  before preparing a login/bootstrap exchange. HTTPS is preferred. CSPRNG
  candidates come from `api.beginLogin` / `beginBootstrap`, before HTTP; the UI
  never expects a token in a server grant.
- First-owner setup takes the operator secret from `server/data/setup-token`.
  There is no public signup. Verified human admins can create accounts, defaulting
  to member; a host-injected authenticated backend without a session grant cannot
  cause the UI to guess an identity or admin role.
- `usePreparedAction` retains the exact prepared request for retry, including
  lost-response uncertainty and Retry-After. A new request is not an automatic
  retry. Uncertain actions cannot be dismissed into a new intent.
- Snapshot creation/restoration and JSON/folder imports recheck live collection
  edit/commit-uncertainty admission immediately before every dispatch, including
  retained retries and edits arriving after preparation. A blocked attempt sends
  nothing and explains that edits need explicit resolution or rollback. The
  original request, key, body, If-Match and uncertainty remain intact; preparation
  is never rerun to manufacture a fresh retry.
- Switching refuses pending/uncertain operations. Unsaved collection edits
  require explicit discard consent and a successful typed rollback. Local mode
  rechecks its save transaction, and opening its chooser leaves the original
  workspace mounted. Explicit sign-out warns before forgetting pending work.
- Sign-out calls server logout and always clears private local state. A failed
  server call visibly says **revocation unconfirmed**, not success. Generation
  keys and response fences prevent old-owner replies repopulating a new session.
  Confirmed privacy sign-out does not require rollback of an in-flight commit;
  that prerequisite applies only to switching. An accepted or uncertain operation
  may still commit: sign-out does not undo server mutations.
  StrictMode cleanup unsubscribes and stops events; disposal is an explicit
  connection-retirement action, not an ordinary effect cleanup.

Pairing uses the human-authenticated six-digit code endpoint. Expiry, attempts,
Retry-After, immediate confirmed revocation, and a manual clipboard fallback for
HTTP contexts are exposed without credential URLs or raw bearer fields.

Snapshots, restore and JSON bundle merge/replace use read strong ETags validated
with `parseWire('VaultETag', response.etag)`, explicit destructive confirmation,
retained durable requests and the returned UUID mapping. Failed reads do not
become empty lists. Imports wait for real server limits and validate byte,
metadata, record, reference, artifact-role and exact serialized-wire caps locally;
server admission remains authoritative.

## Actual upstream folder adapter

The adapter follows the frozen parent's `docs/api-contract.md` “Exact local
OpenHome folder adapter” and `contracts/folder-adapter.fixtures.json`, grounded in
upstream revision `6b6a81d3468e105b9fbbe9dd175148281af54ce3`:

- `openhome_core/src/pkm_storage.rs`: canonical arrays, sparse decimal slot keys,
  nullable names, UUIDs, indices/current selections.
- `openhome_core/src/ohpkm_store.rs` and `pkm_rs/src/ohpkm/id.rs`: real V2 binary
  OHPKM and its embedded `ohpkm.openhomeId`, not a filename or server UUID.
- `openhome_core/src/pokedex.rs`: dex/form-keyed historical entries, game order,
  plugin extras, flags and shiny leaves.
- The pinned engine's `engine/src/pokemon.mjs` `observed()` defines the numeric
  observation/ribbon mapping used when preparing an import bundle.

Select the **storage** directory containing only `banks.json`, `pokedex.json`
and `mons_v2/*.ohpkm`. The browser FileList is fully preflighted: canonical
relative paths only, no traversal/encoded separators/backslashes, duplicate
paths, unknown files, excess counts or oversize reads. No arbitrary ZIP input
is extracted. Browsers without directory selection show an explicit unsupported
message and can still use JSON bundles and folder ZIP downloads. Unknown manifest fields, unsupported legacy forms/missing IDs,
desktop slots 30–119, unknown/repeated placements, unreliable binary identities
and duplicate embedded identities fail visibly before a server import.

Import builds one typed bundle for a single revision-checked operation. Original
OHPKM bytes, embedded backups, nullable names, external folder UUIDs and complete
historical Pokedex entries are preserved. History is not an owned-collection
tracker. Folder files have no account settings, favorites or strategies: the
preview explicitly discloses v1 initial settings for replace; merge retains
current server settings. The returned mapping remaps logical UUID references,
never external folder UUIDs or embedded identities.

Export validates the entire chosen set before writing. It chooses the single
original OHPKM when present, otherwise exact canonical OHPKM; ambiguous originals
fail. Independent same-embedded-ID copies fail by default. Explicit choose-copy
requires one existing UUID and valid unoccupied placement per collision. Omitted
UUIDs and placements are disclosed, not silently deduplicated.

The `fflate` ZIP writer receives generated allowlisted paths only, producing:

```
storage/banks.json
storage/pokedex.json
storage/mons_v2/<embedded-OpenHomeId>.ohpkm
openhome-identity-manifest.json
openhome-vault-bundle.json
```

The companion lossless JSON preserves **all** copies and archived artifacts that
the upstream folder cannot represent. It is not a wrapper upstream OpenHome
already understands. Downloads request a client-local copy, not a verified
overwrite of a native save or server path.

## Validation and evidence

`pnpm test-household` includes both new UI folders. These tests use Testing
Library, the real `RemoteClient`/`RemoteBackend` with a typed mocked HTTP transport,
and real pre-generated WASM/OHPKM bytes. They cover actual App mounting and cold
path separation, HTTP consent, exact auth retries, logout/401 cleanup, unsafe
switch refusal, pairing/revocation/admin controls, destructive snapshot checks,
and source-backed binary folder ZIP round trips/collision policy.

`pnpm test-remote` is unchanged. For frontend-only rebuilding with the existing
generated WASM, use `pnpm exec vite build`; do not rebuild unchanged WASM while
other lanes work.

These are not Rust-service UI E2E, pinned LTS OCI, actual Tauri-shell or physical
console evidence. Independent spec/quality/RUGGED and real API/UI integration
remain release gates. Physical native writes are disabled here pending verified
backup/hardware certification. No Nintendo signing, universal legality or
official HOME compatibility is promised.
