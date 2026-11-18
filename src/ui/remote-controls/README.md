# Household connection & account controls

`src/ui/App.tsx` mounts `src/core/remote/entry.tsx`. Disconnected browsers render
only the chooser without loading Tauri modules or the household workspace, keeping
**Connect later** offline-safe. Connecting mounts `ConnectionRoot`, then
`RemoteSession`, and authenticated sessions load
[`HouseholdWorkspace`](../household/README.md). Tauri desktop shells lazily mount
the unchanged 120-slot `LocalWorkspace`.

## Components

| File                                                                         | Responsibility                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ConnectionRoot.tsx`                                                         | Mode router (`disconnected` / `local` / `remote`), switch refusal & edit-discard guards (`SafetyProvider`)                 |
| `ConnectionChooser.tsx`                                                      | Saved server profile selector and switcher (`openhome.server-profiles.v1`, names + origins only)                           |
| `RemoteSession.tsx`                                                          | Authenticated session shell, WebSocket sync lifecycle, coherence/editing/uncertainty badges                                |
| `AuthForm.tsx`                                                               | Sign-in and first-owner bootstrap form (`setup-token`), explicit HTTP LAN consent checkbox                                 |
| `HumanTools.tsx`                                                             | Container for account pairing, backups, and folder adapter panels                                                          |
| `AccountControls.tsx`                                                        | Six-digit 3DS pairing code generator, device list, and immediate device revocation                                         |
| `BackupControls.tsx`                                                         | Snapshot create/restore and lossless JSON vault bundle import/export (`merge` / `replace`)                                 |
| `FolderControls.tsx`                                                         | Upstream V2 `storage/` folder import/export UI with collision resolution                                                   |
| `LocalWorkspace.tsx`                                                         | Lazy wrapper preserving the upstream 120-slot desktop UI and `TauriBackend`                                                |
| `common.tsx`, `safety.tsx`, `profiles.ts`, `bundles.ts`, `folder-adapter.ts` | Shared confirmations, `usePreparedAction` retry/admission hooks, profile storage, bundle validation, and V2 folder adapter |

## User walkthrough

1. **Sign in or switch to Remote mode:** Add a server profile (only `name` and
   normalized HTTP(S) `origin` are saved). If using plaintext HTTP on a trusted
   LAN, check the unencrypted-traffic consent box. Sign in (`AuthForm.tsx`), or
   use **First run? Set up the owner** with `OPENHOME_DATA_DIR/setup-token`
   (OCI: `/data/setup-token`); subsequent users are created by an admin.
   Accounts require a `3–32` character lowercase username (`a-z`, `0-9`, `_`,
   `-`), a `12–128` character password, and a platform CSPRNG.
2. **Pair a 3DS & manage devices:** Open **Account & 3DS pairing**
   (`AccountControls.tsx`) to generate a one-use six-digit code (with
   expiry/attempt/Retry-After display), pair your console using the server
   origin, username, and code, or revoke paired devices.
3. **Back up or restore snapshots & bundles:** Open **Snapshots & lossless JSON
   backups** (`BackupControls.tsx`) to create labeled snapshots, restore a
   snapshot using its strong `VaultETag`, or export/import a lossless JSON
   bundle (`merge` or `replace`).
4. **Import or export an OpenHome folder:** Open **Upstream OpenHome folder
   adapter** (`FolderControls.tsx`) to import a canonical V2 `storage/`
   directory (`banks.json`, `pokedex.json`, `mons_v2/*.ohpkm`), or click
   **Prepare OpenHome folder export** (resolving any embedded-ID collisions if
   prompted) and then **Download OpenHome folder ZIP** to save an archive
   containing `storage/...`, `openhome-identity-manifest.json`, and the
   companion `openhome-vault-bundle.json`.

## Safety & folder collision policy

- **Memory-only secrets & safe sign-out:** Passwords, setup tokens, pairing
  codes, and retained requests stay in memory only. Sign-out calls server logout
  and clears local private state; if the server request fails, the UI visibly
  reports **revocation unconfirmed** (accepted server commits are not rolled back).
- **Discard unsaved edits before switching:** Switching modes or profiles refuses
  pending/uncertain operations and requires explicit discard confirmation plus a
  successful local rollback; local mode also rechecks active save transactions.
- **Exact retry admission:** Retried requests (`usePreparedAction`) retain the
  exact idempotency key, serialized payload, and `If-Match` revision header
  across uncertain outcomes and `Retry-After` delays so retries never duplicate
  a mutation or overwrite newer server state. Snapshot and bundle/folder imports
  also re-check live edit and uncertainty state right before dispatch so they
  cannot race unsaved collection changes.
- **Folder export collision policy:** Independent records sharing the same
  embedded `OHPKM.openhomeId` fail export by default. You must either **choose a
  new directory** (or export a lossless JSON bundle) or **explicitly choose to
  copy** by selecting one existing UUID and valid unoccupied slot per collision;
  omitted UUIDs and placements are disclosed, never silently deduplicated. See
  [`../../core/remote/README.md`](../../core/remote/README.md) for identity and
  adapter internals.

## Verification

Run from the parent repository root (compile WASM first if not yet generated):

```sh
pnpm --dir openhome wasm-compile-dev
pnpm --dir openhome test-household
pnpm --dir openhome typecheck
```

For a frontend-only build using existing WASM, run `pnpm --dir openhome exec vite build`.
`test-household` exercises Testing Library components against a typed mock HTTP
transport and real WASM/OHPKM bytes. Full-stack Rust-service, WebKit, OCI, and
Tauri integration suites run in the parent `tests/` suite; native 3DS archive
writes remain disabled and unverified.
