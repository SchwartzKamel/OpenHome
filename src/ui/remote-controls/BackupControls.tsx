import {
  type Bundle,
  type BundleImportResult,
  type RemoteBackend,
  type RestoreResult,
  type Snapshot,
  type SnapshotCreated,
  type SnapshotPage,
} from '@openhome-core/remote'
import { Button, Flex } from '@radix-ui/themes'
import { useId, useState } from 'react'
import { jsonBytes, readBundleFile, validateBundle } from './bundles'
import {
  ActionFeedback,
  ConfirmAction,
  FailureNotice,
  freshVaultTag,
  MappingResult,
  vaultMutationAdmission,
} from './common'
import { useConnection, usePreparedAction, usePrivateRead, useSafety } from './safety'

export default function BackupControls({ backend }: { backend: RemoteBackend }) {
  const { connection } = useConnection(backend)
  const snapshots = usePrivateRead<SnapshotPage>(backend)
  const exported = usePrivateRead<string>(backend)
  const [label, setLabel] = useState('')
  const [restoring, setRestoring] = useState<Snapshot>()
  const [restoreResult, setRestoreResult] = useState<RestoreResult>()
  const [created, setCreated] = useState<SnapshotCreated>()
  const create = usePreparedAction<SnapshotCreated>(
    backend,
    ({ data }) => {
      setCreated(data)
      setLabel('')
      void backend.resync()
      loadSnapshots()
    },
    false,
    () => vaultMutationAdmission(backend)
  )
  const restore = usePreparedAction<RestoreResult>(
    backend,
    ({ data }) => {
      setRestoring(undefined)
      setRestoreResult(data)
      void backend.resync()
      loadSnapshots()
    },
    false,
    () => vaultMutationAdmission(backend)
  )
  const id = useId()
  const editing = connection.editing || connection.uncertain
  useSafety(label.length > 0)

  function loadSnapshots(more = false) {
    const previous = snapshots.data
    void snapshots.run(async () => {
      const { data } = await backend.api.call('listSnapshots', {
        query: {
          limit: 100,
          ...(more && previous && { at_revision: previous.revision }),
          ...(more && previous?.next_cursor && { cursor: previous.next_cursor }),
        },
      })
      return more && previous ? { ...data, items: [...previous.items, ...data.items] } : data
    })
  }

  function download(snapshot?: Snapshot) {
    void exported.run(async () => {
      const response = snapshot
        ? await backend.api.call('exportSnapshot', { path: { snapshot_id: snapshot.id } })
        : await backend.api.call('exportBundle', {})
      validateBundle(response.data, connection.status?.limits)
      await backend.files.saveLocalFile(
        jsonBytes(response.data),
        snapshot
          ? `openhome-snapshot-${snapshot.id}.json`
          : `openhome-vault-r${response.data.source_revision}.json`
      )
      return 'JSON bundle download requested. Verify your backup; this is not an upstream OpenHome folder.'
    })
  }

  return (
    <details className="remote-panel">
      <summary>Snapshots &amp; lossless JSON backups</summary>
      <p>
        Backups include exact retained originals and archived artifacts. A server bundle is not an
        upstream OpenHome folder. Restore and replace are destructive revision-checked operations;
        originals and a pre-change snapshot remain on the server.
      </p>
      {editing && (
        <p role="alert">
          Finish collection edits and resolve uncertainty before snapshot/import mutations.
        </p>
      )}
      <section aria-label="Snapshot controls">
        <h2>Snapshots</h2>
        <Button
          type="button"
          variant="soft"
          disabled={snapshots.busy}
          onClick={() => loadSnapshots()}
        >
          {snapshots.data ? 'Refresh snapshots' : 'Load snapshots'}
        </Button>
        {snapshots.busy && <p role="status">Loading snapshots…</p>}
        <FailureNotice failure={snapshots.failure} />
        {!snapshots.data && !snapshots.busy && <p>Snapshots have not been loaded.</p>}
        <form
          className="remote-form"
          aria-busy={create.busy}
          onSubmit={(event) => {
            event.preventDefault()
            if (create.busy || create.retained || editing) return
            void create.start(async () =>
              backend.api.prepare('createSnapshot', {
                body: { label },
                ifMatch: await freshVaultTag(backend),
              })
            )
          }}
        >
          <label htmlFor={`${id}-label`}>Snapshot label</label>
          <input
            id={`${id}-label`}
            value={label}
            maxLength={64}
            disabled={create.busy || create.retained}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit" disabled={editing || create.busy || create.retained}>
            Create snapshot
          </Button>
        </form>
        {created && (
          <p role="status">
            Snapshot “{created.snapshot.label || created.snapshot.id}” created at revision{' '}
            {created.revision}.
          </p>
        )}
        <ActionFeedback action={create} />
        {snapshots.data && (
          <>
            {snapshots.data.items.length === 0 && <p>No server snapshots.</p>}
            <ul className="remote-list">
              {snapshots.data.items.map((snapshot) => (
                <li key={snapshot.id}>
                  <div>
                    <strong>{snapshot.label || 'Unlabelled snapshot'}</strong>
                    <p>
                      Revision {snapshot.source_revision} · {snapshot.reason} ·{' '}
                      {new Date(snapshot.created_at).toLocaleString()}
                    </p>
                  </div>
                  <Flex gap="2" wrap="wrap">
                    <Button
                      type="button"
                      variant="soft"
                      disabled={exported.busy}
                      onClick={() => download(snapshot)}
                    >
                      Export snapshot {snapshot.label || snapshot.id}
                    </Button>
                    <Button
                      type="button"
                      variant="soft"
                      color="red"
                      disabled={editing || restore.busy || restore.retained}
                      onClick={() => setRestoring(snapshot)}
                    >
                      Restore {snapshot.label || snapshot.id}
                    </Button>
                  </Flex>
                </li>
              ))}
            </ul>
            {snapshots.data.next_cursor && (
              <Button type="button" disabled={snapshots.busy} onClick={() => loadSnapshots(true)}>
                Load more snapshots
              </Button>
            )}
          </>
        )}
        {restoring && !restore.retained && (
          <ConfirmAction
            title="Restore snapshot?"
            action="Restore snapshot now"
            busy={restore.busy}
            onCancel={() => setRestoring(undefined)}
            onConfirm={() => {
              const snapshotId = restoring.id
              void restore.start(async () =>
                backend.api.prepare('restoreSnapshot', {
                  path: { snapshot_id: snapshotId },
                  body: {},
                  ifMatch: await freshVaultTag(backend),
                })
              )
            }}
          >
            Replace your active collection and layout with “{restoring.label || restoring.id}” from
            revision {restoring.source_revision}. This is not a merge. Restored logical copies can
            receive new UUIDs; inspect the returned mapping. Credentials are not restored.
          </ConfirmAction>
        )}
        <ActionFeedback action={restore} />
        {restoreResult && (
          <MappingResult revision={restoreResult.revision} mappings={restoreResult.id_map} />
        )}
      </section>
      <section aria-label="JSON bundle export">
        <h2>Lossless JSON bundle</h2>
        <Button type="button" disabled={exported.busy} onClick={() => download()}>
          Export JSON bundle
        </Button>
        {exported.busy && <p role="status">Exporting verified bundle…</p>}
        {exported.data && <p role="status">{exported.data}</p>}
        <FailureNotice failure={exported.failure} />
        <BundleImporter backend={backend} disabled={editing} />
      </section>
    </details>
  )
}

function BundleImporter({ backend, disabled }: { backend: RemoteBackend; disabled: boolean }) {
  const { connection } = useConnection(backend)
  const preview = usePrivateRead<Bundle>(backend)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<BundleImportResult>()
  const action = usePreparedAction<BundleImportResult>(
    backend,
    ({ data }) => {
      setResult(data)
      preview.clear()
      void backend.resync()
    },
    false,
    () => vaultMutationAdmission(backend)
  )
  const locked = action.busy || action.retained || preview.busy
  const id = useId()
  useSafety(preview.data !== undefined)
  return (
    <>
      <div className="remote-form">
        <label htmlFor={`${id}-file`}>Preview server JSON bundle</label>
        <input
          id={`${id}-file`}
          type="file"
          accept=".json,application/json"
          disabled={locked || !connection.status}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            preview.clear()
            setResult(undefined)
            void preview.run(() => readBundleFile(file, connection.status?.limits))
          }}
        />
        <label htmlFor={`${id}-mode`}>Bundle import mode</label>
        <select
          id={`${id}-mode`}
          value={mode}
          disabled={locked}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'merge' || value === 'replace') setMode(value)
          }}
        >
          <option value="merge">Merge — append remapped copies, retain current settings</option>
          <option value="replace">Replace — replace active content and settings</option>
        </select>
      </div>
      {!connection.status && (
        <p>
          Server limits are not available yet. Refresh the server connection before reading a
          bundle.
        </p>
      )}
      {preview.busy && (
        <p role="status">Validating sizes, artifact roles, references and SHA-256…</p>
      )}
      <FailureNotice failure={preview.failure} />
      {preview.data && (
        <div className="remote-preview">
          <p>
            Preview only: {preview.data.pokemon.length} Pokémon ·{' '}
            {preview.data.content.banks.length} banks · {preview.data.artifacts.length} artifacts ·
            source revision {preview.data.source_revision}.
            {mode === 'merge'
              ? ' Merge creates independent remapped logical copies. Conflicting digest lookups or history require explicit resolution, not silent deduplication.'
              : ' Replace changes the active collection and imports the bundle settings. Old original BLOBs remain retained.'}
          </p>
          <Flex gap="2" wrap="wrap">
            <Button
              type="button"
              disabled={disabled || locked}
              color={mode === 'replace' ? 'red' : undefined}
              onClick={() => setConfirm(true)}
            >
              Review {mode} import
            </Button>
            <Button type="button" variant="soft" disabled={locked} onClick={preview.clear}>
              Discard preview
            </Button>
          </Flex>
        </div>
      )}
      {confirm && preview.data && !action.retained && (
        <ConfirmAction
          title={mode === 'replace' ? 'Replace active collection?' : 'Merge bundle as new copies?'}
          action={mode === 'replace' ? 'Replace from bundle' : 'Merge bundle now'}
          onCancel={() => setConfirm(false)}
          busy={action.busy}
          onConfirm={() => {
            const bundle = preview.data
            if (!bundle) return
            setConfirm(false)
            void action.start(async () =>
              backend.api.prepare('importBundle', {
                body: { mode, bundle },
                ifMatch: await freshVaultTag(backend),
              })
            )
          }}
        >
          {mode === 'replace'
            ? 'The active vault will be replaced, not merged. A pre-replace snapshot and retained originals remain recoverable.'
            : 'This is a new COPY intent. It will append records with new IDs; it will not move files or silently collapse duplicate bytes.'}{' '}
          The server validates ownership, quotas, artifact roles and reservations again.
        </ConfirmAction>
      )}
      <ActionFeedback action={action} />
      {result && <MappingResult revision={result.revision} mappings={result.id_map} />}
    </>
  )
}
