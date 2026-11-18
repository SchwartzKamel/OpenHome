# Household remote backend

`src/core/remote` implements `RemoteBackend` and the typed transport layer for the
[connection/account controls](../../ui/remote-controls/README.md) and
[household workspace](../../ui/household/README.md). `App.tsx` mounts `entry.tsx`;
Tauri shells lazily load the unchanged `TauriBackend` singleton in Local mode, while
browsers offer **Connect later** without importing Tauri runtime modules.

```tsx
import { RemoteBackend } from '@openhome-core/remote'

const backend = new RemoteBackend({ baseUrl: 'https://household.example' })
const login = backend.api.beginLogin(username, password)
await login.send() // Retain `login` to retry lost responses with the same token/key
```

## Module & Export Map

| File                                                | Key Exports / Role                                                                                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                          | Barrel exports (`RemoteBackend`, `RemoteClient`, `MemoryCredentialStore`, `RemoteEvents`, `RemoteError`, `parseWire`, `isDesktopShell`, `loadLocalBackend`, `decodeBytes`, `newId`, `pokemonInput`, `saveInput`, and wire types) |
| `backend.ts`                                        | `RemoteBackend`, `RemoteBackendOptions`, `RemoteConnectionState` — implements `BackendInterface` for 30-slot vaults, staging/commit/rebase, legacy projection, and unavailable native/plugin guards                              |
| `client.ts`                                         | `RemoteClient`, `MemoryCredentialStore`, `PreparedRequest`, `ApiResponse` — typed HTTP transport for all 31 operations, `Idempotency-Key`, `If-Match`, schema validation, and credential-epoch fencing                           |
| `events.ts`                                         | `RemoteEvents`, `EventSocket`, `SocketFactory` — WebSocket invalidation listener (first-frame auth, sequence-gap/409 full resync, bounded reconnects)                                                                            |
| `state.ts`                                          | `CollectionSnapshot`, `applyCommands`, `validateContent`, `trackerCounts`, `compatibility` — local command staging and revision checks                                                                                           |
| `identity.ts`                                       | `IdentityMap`, `readOhpkm`, `projectBanks`, `translateBanks` — V2 binary OHPKM identity verification and 30-slot sparse bank mapping                                                                                             |
| `crypto.ts`                                         | `newId`, `newBearer`, `encodeBase64`, `sha256`, `decodeBytes`, `pokemonInput`, `saveInput` — HTTP-LAN-safe CSPRNG/SHA-256 via `crypto-js` & `uuid`                                                                               |
| `errors.ts`                                         | `RemoteError`, `RemoteResult`, `failed`, `remoteError`, `unavailable`, `unwrap` — typed errors preserving `code`, `httpStatus`, `details`, `uncertain`, `retryAfterSeconds`                                                      |
| `validation.ts`                                     | `parseWire`, `parseJson`, `validate`, `isObject` — bounded UTF-8 strict JSON parsing, duplicate/unknown-key rejection, and schema checks                                                                                         |
| `files.ts`                                          | `ClientFiles` — browser `File` handles (`client-file:<uuid>`), download writes, and conditional Tauri delegation                                                                                                                 |
| `local.ts`                                          | `isDesktopShell`, `loadLocalBackend` — runtime Tauri check and lazy `TauriBackend` loader                                                                                                                                        |
| `entry.tsx`, `Startup.tsx`                          | `RemoteEntry`, `useStartupBackend`, `Disconnected`, `RemoteVault` — cold startup entry and session shell                                                                                                                         |
| `wire-types.ts`, `wire-schema.json`, `generate.mjs` | Frozen DTOs, JSON schemas, and contract codegen script from parent `docs/api-contract.md` and `contracts/`                                                                                                                       |

## Auth, Transport & Retry Invariants

- **Memory-only tokens:** Default credentials use `MemoryCredentialStore` (`Authorization: Bearer`). Never persist tokens in `localStorage`, `IndexedDB`, cookies, or service-worker caches. `api.logout()` clears local state even if server revocation fails; `dispose()` clears local listeners/sockets and is **not** a server logout.
- **Explicit HTTP risk consent:** Plaintext HTTP requires `acknowledgeInsecureHttp: true` or `api.acknowledgeInsecureHttp()` after showing the LAN risk warning. No TLS bypass or URL credentials exist.
- **Idempotency & durable retries:** `api.prepare(operationId, input)` creates a `PreparedRequest` with a random `Idempotency-Key`. Always retain and call `send()` on that same `PreparedRequest` for retries—calling `api.call()` again creates a new logical intent. Use `beginLogin`, `beginBootstrap`, and `beginClaim` so CSPRNG bearer proofs are retained before HTTP dispatch.
- **Monotonic uncertainty:** Once a commit or durable request has an uncertain outcome (`failure.uncertain`), key, serialized bytes, and `If-Match` stay frozen until the actual receipt resolves it; later 429/503 retries never clear uncertainty early.
- **Credential-epoch fencing:** HTTP reads/proofs recheck credential generation and latest-intent ownership after headers, body reads, and validation. A `401` or WS `4401` clears credentials, caches, and staged edits without allowing stale responses to repopulate a newer session.

## Transaction, Locking & Vault Separation

- **Optimistic locking (`If-Match` / `ETag`):** Pass `parseWire('VaultETag', response.etag)` (or `TradeETag`) into mutations. Definite `409` conflicts keep local edits intact and require `resync()` plus an explicit `rebaseTransaction((current, staged) => merged)`—never an automatic overwrite (deletions must be rolled back/restaged, not rebased).
- **Staging & rollback:** `startTransaction()`, `stageCommands()`/`stageContent()`, `checkpoint()`/`rewind()`, `rollbackTransaction()`, and `commitTransaction()` stage locally with one aggregate HTTP commit (never mixing full `replace` with `pokemon_delete`). Acknowledged writes advance `lastCommittedRevision` even if post-commit refresh fails.
- **COPY imports:** PKM/save imports are independent durable COPY operations prior to box placement; `rollbackTransaction()` never undoes a committed import.
- **Local vs Remote separation:** `RemoteBackend` exposes exactly 30 slots per box (`capabilities`) and never truncates desktop slots 30–119. There is no atomic local-file/server-vault transaction: local save writers fail while a remote edit buffer is open.
- **Unavailable desktop & native features:** Plugins, item bag, server directories/logs, legacy lookup writes, handler repair, and **native 3DS archive writes** are explicitly unavailable (`unavailableOperations` / `allow_lossy: false` default). This module never certifies native writes or bypasses server hardware gates.
- **Identity & folder adapter:** `IdentityMap` verifies V2 `MainData` identity against `ohpkm.openhomeId` without regenerating PID/TID/SID. Prefer typed box/record views for browsing; see [`../../ui/remote-controls/README.md`](../../ui/remote-controls/README.md) for folder import/export and collision rules.

### Legacy `BackendInterface` Mapping

| Capability area                                                    | Remote mode behavior                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Vault banks, box slots (30/box), OHPKM decoding                    | Real vault/record reads and binary OHPKM validation                              |
| Bank writes, deletions, theme settings, Pokédex history            | Local staging, then one revision-checked commit                                  |
| Legacy lookups & search                                            | Read-only Gen1–5 IDs + exact species/form/nickname/shiny/level filters           |
| Plugins, item bag, server dirs/logs, handler repair, lookup writes | Explicitly unavailable (`unavailableOperations` throws/errors)                   |
| File dialogs & browser uploads                                     | Client-local `ClientFiles` handles (`client-file:<uuid>`) and explicit downloads |

## Build & Verification

WASM must be compiled before running typecheck or tests. From the parent repository root:

```sh
pnpm --dir openhome wasm-compile-dev
pnpm --dir openhome test-remote
pnpm --dir openhome typecheck
pnpm --dir openhome build
```

If the parent API contract changes, regenerate schemas from `openhome/`:

```sh
node src/core/remote/generate.mjs
pnpm exec oxfmt src/core/remote/wire-types.ts src/core/remote/wire-schema.json
```

`test-remote` exercises an ephemeral localhost HTTP server, controlled WebSocket frames, and real PK8/OHPKM/WASM bytes. Full Rust-service, WebKit, OCI, and Tauri integration suites live in the parent `tests/` directory; physical 3DS writes remain disabled.
