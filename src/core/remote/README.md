# Household remote backend

This is the backend slice, not the complete household UI. `App` accepts an optional
`backend` prop. Without one, the actual Tauri shell lazily loads the **unchanged**
`TauriBackend` singleton; a browser shows **Connect later** without evaluating
Tauri runtime modules. Remote mode renders a small authenticated bank browser,
not the desktop's incompatible plugins/item-bag/120-slot editing screens.

## Connection handoff

```tsx
import { RemoteBackend } from '@openhome-core/remote'

const backend = new RemoteBackend({ baseUrl: 'https://household.example' })
const login = backend.api.beginLogin(username, password)
await login.send()
// Retain `login` to retry a lost response: its token, key and bytes stay identical.
// The server grant deliberately does not contain a token.
// Mounting this starts HTTP synchronization and event invalidations.
;<App backend={backend} />
```

Default credentials are memory-only. `CredentialStore` injection is for a trusted
memory or **session-only** implementation, never localStorage, IndexedDB, durable
cookies or service-worker caching. Call `api.logout()` for server revocation;
it always clears local credentials even if the request fails, without claiming
the server acknowledged that failure. `dispose()` clears local state/listeners
and closes sockets; it is **not** a server logout. Do not dispose on every React
effect cleanup; `stopEvents()` only stops the current subscription.

HTTP requires `acknowledgeInsecureHttp: true` or an explicit
`api.acknowledgeInsecureHttp()` call **after displaying the risk**.
`connection.transportSecurity` continues to expose the insecure state. No TLS
downgrade, certificate bypass, URL credential or weak-PRNG fallback exists.
`crypto-js` SHA-256 and `uuid` with explicit CSPRNG bytes work without
`crypto.subtle`/`crypto.randomUUID` on HTTP LAN origins.

## Typed API for the next UI slice

`api.call(operationId, input)` and `api.prepare(operationId, input)` cover the
31 frozen HTTP operations; `RemoteEvents` implements the remaining WS operation.
`wire-types.ts` supplies closed DTOs, operation inputs and outputs. Path
parameters go in `path`, search parameters in `query`, payloads in `body`,
strong revision preconditions in `ifMatch`. The client supplies a random
`Idempotency-Key` for every durable operation. Empty POSTs send `{}`; DELETEs
have no body.

For **every durable retry**, retain the `PreparedRequest` and call its `send()`
again. Recreating it (including through `call`) means a new logical intent, and
an import with a new key intentionally creates another copy. Convenience `call`
is appropriate for reads and one-shot new intents, not automatic mutation retry.
Use `beginLogin`, `beginBootstrap` or `beginClaim` for credential exchanges so the
candidate is generated **before** the request and retained for its receipt.

The existing operation IDs cover account creation, pairing/revocation, typed
metadata/search/trackers, save inspection, snapshots, JSON bundle merge/replace,
trades and transfer recovery. These calls are implemented, **not** newly added
screens. Retain requests during uncertainty; transfer preparation also uses a
stable client-generated `transfer_id`. This module never certifies a native
write or bypasses a server hardware gate.

Responses and requests pass frozen schema guards, bounded UTF-8/strict JSON
parsing, unknown/duplicate-key rejection, strong tag checks and binary
base64/length/SHA-256 verification. `ApiResponse` returns `{ data, etag }`.
Use `parseWire('VaultETag', response.etag)` (or `TradeETag`) when passing a read
tag into a typed mutation. Client guards do not replace server ownership,
reservation, lineage, quota or recovery-state validation.
`RemoteError` has `code`, `httpStatus`, typed `details`, `uncertain` and
`retryAfterSeconds`. Do not replace these with a generic success or empty list.

## Transaction semantics

- `startTransaction()` clones revisioned local content. Mutators stage locally;
  no server transaction is held open across requests. A pre-existing implicit
  edit buffer is retained; nested explicit starts fail visibly.
- Use `stageCommands()` for closed deltas and `stageContent()` for full typed
  non-binary replacement. `commitTransaction()` sends **one** aggregate commit
  with the original strong tag and a retained key/body.
- `checkpoint()`/`rewind()` are local undo points. `rollbackTransaction()` drops
  the buffer without HTTP. Neither may discard an in-flight/uncertain commit:
  replay its exact retained request first. All edit/checkpoint/rebase guards are
  rechecked after awaits, before modifying the buffer.
- Uncertainty is monotonic for one logical commit. A later receipt retry returning
  503, 429 or another error does not establish that the earlier request failed.
  Its key, serialized bytes, precondition and expected receipt remain frozen;
  `failure.uncertain` stays true until the actual acknowledgement resolves it.
- HTTP errors, malformed successes and conflicts preserve edits. A definite
  stale revision requires `resync()` followed by an explicit
  `rebaseTransaction((current, staged) => merged)` and a new key, never an
  automatic overwrite. A pending rebase cannot resurrect a rolled-back buffer.
- Acknowledged writes remain acknowledged if the subsequent read fails:
  `lastCommittedRevision` records the acknowledgement, `coherent` becomes false,
  and `lastError` exposes the refresh failure. Do not replay a fresh mutation.
  A pre-acknowledgement resync cannot publish below the current acknowledgement
  floor: its completion is fenced against both that floor and newer invalidations,
  and an obsolete traversal is restarted rather than advertised as coherent.
- Imports are independent durable **COPY** operations before placement.
  Rollback cannot undo a prior import. Browse/remove unplaced records explicitly.
- The frozen union cannot combine full `replace` with `pokemon_delete` in one
  request. Mixing these in either order fails visibly; use an expressible delta
  or a deliberate separate operation, never split an alleged atomic save.

`subscribe()` reports `connection`: authentication, coherent revision, pending
edits/conflict/uncertainty, processed event sequence, real status/capabilities and
errors. WS credentials are the first frame, not the URL or subprotocol. First
authentication, reconnect, sequence gaps and resync frames trigger a full vault
plus revision-pinned Pokemon traversal. Buffered invalidations are reconciled
before marking the result coherent. 409 restarts traversal; failed resync does
not advance the cursor. Heartbeats, bounded reconnects and Retry-After apply.
401 or WS 4401 clears credentials, binary maps, snapshots, edits and local upload
memory. In-flight old-credential reads cannot repopulate them.
HTTP request ownership is rechecked after headers, streamed body completion,
validation and delivery. A delayed obsolete 401 is cancelled without clearing
the replacement session. Login/bootstrap/claim proofs have their own latest-intent
ownership, so a superseded candidate cannot win merely by completing first;
a current pending proof can outlive clearing its previous bearer. An explicit
`clearCredentials()` also cancels pending proofs.

## Existing `BackendInterface`

The string-error ABI is preserved. Remote results additionally carry a typed
`failure: RemoteError` on their error arm; `connection.lastError` retains it for
capability-aware controls. Methods whose upstream signature has no result arm
(`loadItemBag`, native-path helpers, `onNewLog`) throw typed errors when unavailable.

| Area                                                              | Behavior                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Banks, count, lookups, batch lookup/search                        | Real vault/record reads and binary OHPKM decoding                                                                        |
| Bank writes, deletions, settings/theme, historical Pokedex        | Local staging, then one checked commit                                                                                   |
| Legacy generation lookup reads                                    | Derived from actual canonical OHPKM; ambiguous identities fail                                                           |
| Legacy search filters                                             | Exact species/form/nickname-prefix/shiny/level; other predicates explicitly unavailable                                  |
| Settings UI-only fields                                           | Tab-local preferences; only theme maps to remote settings; no enabled remote plugins                                     |
| Legacy lookup writes, byte edits/handler repair, conversion flags | Explicitly unavailable; use SHA lineage lookup commands, COPY imports or typed remote strategies as appropriate          |
| Item bag, server directories/logs, plugins/code/downloads         | Explicitly unavailable; never bridged                                                                                    |
| Menu events                                                       | Client-local event bus with real unsubscribe                                                                             |
| Collection listeners                                              | Pokedex/lookups/layout updates; `onStateUpdate` supports only `vault` and `remote_connection`, not arbitrary desktop IPC |

`capabilities` exposes the exclusions and exactly 30 vault slots. Never silently
truncate desktop slots 30–119 or reuse the desktop's complete save-all workflow.
There is no atomic local-file/server-vault transaction: local save writers fail
while a vault edit buffer exists. Build explicit verified transfer controls in
the next slice.

Dialogs, file reads/writes, recent saves and directory scanning stay on the
**client**. In the actual shell they conditionally delegate to the original
backend. Browser `files.upload(File)` / `pickFile()` retains bytes under an
opaque tab-local handle; arbitrary paths fail, and writes are explicit byte
downloads rather than claimed path overwrites. No local filename/path is sent
as an engine detection hint or a server filesystem operation.

## Identity and folder foundations

Server Pokemon UUIDs are **not** `OHPKM.openhomeId`. `IdentityMap` reads real
binary OHPKM, retaining the exact input and embedded original backup, not JSON.
It checks the pinned V2 MainData stored identity against the actual getter;
the upstream zero-component fallback is not accepted as a restored identity.
No binary/PID/TID/SID regeneration is performed.

`projectBanks` / `translateBanks` map 30 nullable UUID slots to sparse
OpenHome-ID Maps and back, preserving external folder UUIDs, nullable names,
indices/current selections and historical Pokedex entries through
`openhome_compatibility`. Invalid indices, unknown IDs, repeated placements and
colliding embedded identities fail visibly. Same-ID server copies remain
distinct in the typed server view/bundle; the legacy projection cannot silently
collapse them.

Complete folder file import/export and explicit choose-copy controls are **next
UI/adapter work**, not a claim made by these foundations. Use the lossless JSON
bundle for independent copies. A complete legacy identity projection lazily
downloads canonical OHPKM for all active records; large collections can hit the
server read budget. Prefer the typed summary/30-record box views for incremental
UI browsing rather than repeatedly hydrating the legacy projection.

## Generation, validation and evidence boundaries

From the client directory, regeneration (only after a reviewed contract change):

```sh
node src/core/remote/generate.mjs
pnpm exec oxfmt src/core/remote/wire-types.ts src/core/remote/wire-schema.json
```

The generator reads the parent's frozen OpenAPI/types/events artifacts and
embeds their source SHA-256. Production needs no parent checkout or new package.
No dependency or engine-version change was required.

```sh
pnpm --dir openhome test-remote
pnpm --dir openhome typecheck
pnpm --dir openhome build
```

`test-remote` uses existing Vitest and the real pre-generated WASM without
rebuilding Rust. Tests use an ephemeral localhost HTTP server, actual fetch
bodies/headers and real PK8/OHPKM bytes, plus controlled socket protocol tests.
The browser test imports/renders the actual entry, makes Tauri runtime imports
fatal and exercises Connect later. The local adapter test checks the original
singleton, paths, command references and listener cleanup.
`ordering.test.ts` additionally holds real HTTP bodies/pages and interleaves
logout, replacement proofs, undo, receipt failures and acknowledgements. These
regressions must stay green alongside the original adapter tests; sequential
happy-path tests alone do not establish the ownership/publication guarantees.

These are adapter/browser-import tests, **not** Rust-service end-to-end, LTS OCI,
actual Tauri-shell or physical-console evidence. Actual `ui-test`/desktop smoke,
server integration, two independent non-author reviews and RUGGED remain separate
gates. The existing GTK/WebKit/Xvfb environment is not itself a successful native
launch; WebKitWebDriver discovery/setup remains follow-up work.
