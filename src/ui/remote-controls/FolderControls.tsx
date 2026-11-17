import {
  type BundleImportResult,
  type OpenHomeIdentityLink,
  type RemoteBackend,
  type SlotAddress,
} from '@openhome-core/remote'
import { Button, Flex } from '@radix-ui/themes'
import { useId, useState } from 'react'
import { jsonBytes } from './bundles'
import {
  ActionFeedback,
  ConfirmAction,
  FailureNotice,
  freshVaultTag,
  MappingResult,
  vaultMutationAdmission,
} from './common'
import {
  type CopyChoice,
  folderArchive,
  type FolderCollision,
  type FolderExportPlan,
  type FolderImportPreview,
  inspectFolderExport,
  readOpenHomeFolder,
  remapIdentityManifest,
} from './folder-adapter'
import { safeFailure, useConnection, usePreparedAction, usePrivateRead, useSafety } from './safety'

export default function FolderControls({ backend }: { backend: RemoteBackend }) {
  return (
    <details className="remote-panel">
      <summary>Upstream OpenHome folder adapter</summary>
      <p>
        Actual V2 files: <code>storage/banks.json</code>, <code>storage/mons_v2/*.ohpkm</code> and{' '}
        <code>storage/pokedex.json</code>. Embedded OpenHome IDs are not server UUIDs. We never
        rewrite creature bytes, discard history or silently collapse independent copies.
      </p>
      <FolderImporter backend={backend} />
      <FolderExporter backend={backend} />
      <p>
        Folder input must already have the pinned canonical V2 shape. Upgrade legacy or missing-ID
        layouts in the desktop app first. No server paths, ZIP extraction or host filesystem writes
        are exposed. These tools do not certify physical console writes or official HOME
        compatibility.
      </p>
    </details>
  )
}

function FolderImporter({ backend }: { backend: RemoteBackend }) {
  const { connection } = useConnection(backend)
  const preview = usePrivateRead<FolderImportPreview>(backend)
  const download = usePrivateRead<string>(backend)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<BundleImportResult>()
  const [identityMap, setIdentityMap] = useState<OpenHomeIdentityLink[]>()
  const [mappingError, setMappingError] = useState<ReturnType<typeof safeFailure>>()
  const [directorySupported] = useState(() => 'webkitdirectory' in document.createElement('input'))
  const action = usePreparedAction<BundleImportResult>(
    backend,
    ({ data }) => {
      setResult(data)
      if (preview.data) {
        try {
          setIdentityMap(remapIdentityManifest(preview.data.identity_map, data.id_map))
        } catch (error) {
          setMappingError(safeFailure(error))
        }
      }
      preview.clear()
      void backend.resync()
    },
    false,
    () => vaultMutationAdmission(backend)
  )
  const locked = preview.busy || action.busy || action.retained
  const id = useId()
  useSafety(preview.data !== undefined)
  return (
    <section aria-label="Import OpenHome folder">
      <h2>Import OpenHome storage folder</h2>
      <p>
        Select only the storage folder’s canonical manifests and mons_v2 directory. File counts,
        metadata and byte caps are checked before binary reads; every actual embedded identity and
        SHA-256 is validated locally before any import request.
      </p>
      <div className="remote-form">
        <label htmlFor={`${id}-folder`}>OpenHome storage folder</label>
        <input
          id={`${id}-folder`}
          type="file"
          multiple
          disabled={locked || !connection.status || !directorySupported}
          ref={(element) => {
            element?.setAttribute('webkitdirectory', '')
          }}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length === 0) return
            preview.clear()
            setResult(undefined)
            setIdentityMap(undefined)
            setMappingError(undefined)
            void preview.run(() => readOpenHomeFolder(files, connection.status?.limits))
          }}
        />
        <label htmlFor={`${id}-mode`}>Folder import mode</label>
        <select
          id={`${id}-mode`}
          value={mode}
          disabled={locked}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'merge' || value === 'replace') setMode(value)
          }}
        >
          <option value="merge">Merge — append independent banks and copies</option>
          <option value="replace">Replace — exact upstream layout/history round trip</option>
        </select>
      </div>
      {!connection.status && (
        <p>
          Server limits are unavailable. Refresh the connection before reading local folder
          binaries.
        </p>
      )}
      {!directorySupported && (
        <p>
          Directory uploads are unsupported in this browser. Use a browser with directory selection,
          or the lossless JSON bundle controls. Folder ZIP downloads remain available.
        </p>
      )}
      {preview.busy && (
        <p role="status">Reading canonical manifests and checking original OHPKM bytes…</p>
      )}
      <FailureNotice failure={preview.failure ?? mappingError} />
      {preview.failure && (
        <p>
          The folder was not imported. Unknown members, duplicate embedded IDs, noncanonical paths,
          invalid history, unknown placements and desktop slots beyond 29 must be resolved at
          source; nothing is silently discarded.
        </p>
      )}
      {preview.data && (
        <>
          <p>
            Preview only: {preview.data.bundle.pokemon.length} Pokémon ·{' '}
            {preview.data.bundle.content.banks.length} banks · {preview.data.original_bytes}{' '}
            original bytes ·{' '}
            {preview.data.bundle.content.openhome_compatibility?.pokedex_history.length} historical
            forms. Historical Seen/Caught entries do not create owned Pokémon or observed tracker
            counts.
          </p>
          <p>
            Folder files contain no account settings, favorites, tags or conversion strategies.
            Replace uses explicit v1 initial settings (system theme, English, manual order,
            retention 10); merge retains existing settings. All exact input OHPKM and embedded
            backups are retained. The server remaps logical UUIDs and returns a separate identity
            manifest; external folder UUIDs and embedded OpenHome IDs remain unchanged.
          </p>
          <Flex gap="2" wrap="wrap">
            <Button
              type="button"
              disabled={locked || connection.editing || connection.uncertain}
              onClick={() => setConfirm(true)}
            >
              Review folder {mode}
            </Button>
            <Button type="button" variant="soft" disabled={locked} onClick={preview.clear}>
              Discard folder preview
            </Button>
          </Flex>
        </>
      )}
      {confirm && preview.data && !action.retained && (
        <ConfirmAction
          title={
            mode === 'replace'
              ? 'Replace from OpenHome folder?'
              : 'Merge OpenHome folder as copies?'
          }
          action={mode === 'replace' ? 'Replace from folder' : 'Merge folder now'}
          busy={action.busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            const bundle = preview.data?.bundle
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
            ? 'The active collection, layout and historical Pokedex will be replaced. The server retains old originals and a pre-change snapshot.'
            : 'New logical copies and complete banks will be appended. A duplicate lookup digest or conflicting history is a visible server conflict, not a deduplication instruction.'}{' '}
          Only typed JSON and binary bytes are uploaded. No client directory or filename is sent.
        </ConfirmAction>
      )}
      <ActionFeedback action={action} />
      {result && <MappingResult revision={result.revision} mappings={result.id_map} />}
      {identityMap && (
        <Button
          type="button"
          variant="soft"
          disabled={download.busy}
          onClick={() =>
            void download.run(async () => {
              await backend.files.saveLocalFile(
                jsonBytes({
                  format: 'openhome-folder-identity-manifest',
                  version: 1,
                  identity_map: identityMap,
                  server_revision: result?.revision,
                }),
                'openhome-import-identity-manifest.json'
              )
              return 'Remapped identity manifest download requested.'
            })
          }
        >
          Download imported identity manifest
        </Button>
      )}
      {download.data && <p role="status">{download.data}</p>}
      <FailureNotice failure={download.failure} />
    </section>
  )
}

function FolderExporter({ backend }: { backend: RemoteBackend }) {
  const { connection } = useConnection(backend)
  const preview = usePrivateRead<FolderExportPlan>(backend)
  const download = usePrivateRead<string>(backend)
  const [choices, setChoices] = useState<Record<string, CopyChoice>>({})
  const [confirm, setConfirm] = useState(false)
  const [validation, setValidation] = useState<ReturnType<typeof safeFailure>>()
  const plan = preview.data
  const allChosen = preview.data?.collisions.every((collision) => choices[collision.openhome_id])
  useSafety(preview.data !== undefined)
  function writeArchive() {
    const plan = preview.data
    if (!plan) return
    setConfirm(false)
    setValidation(undefined)
    const generation = backend.api.generation
    void download.run(async () => {
      const archive = folderArchive(plan, choices)
      if (backend.api.generation !== generation) throw new Error('Authenticated identity changed.')
      await backend.files.saveLocalFile(
        archive,
        `openhome-folder-r${plan.bundle.source_revision}.zip`
      )
      return 'Folder ZIP download requested. It includes storage/, the external identity manifest, and a lossless server JSON companion preserving all copies and archived originals. Extract it locally only after verifying your backup.'
    })
  }
  return (
    <section aria-label="Export OpenHome folder">
      <h2>Export actual OpenHome folder files</h2>
      <Button
        type="button"
        variant="soft"
        disabled={preview.busy || download.busy || !connection.status}
        onClick={() => {
          preview.clear()
          setChoices({})
          setValidation(undefined)
          void preview.run(async () => {
            const { data } = await backend.api.call('exportBundle', {})
            return inspectFolderExport(data, connection.status?.limits)
          })
        }}
      >
        Prepare OpenHome folder export
      </Button>
      {preview.busy && (
        <p role="status">
          Validating every selected original, binary identity and layout before any file is written…
        </p>
      )}
      <FailureNotice failure={preview.failure ?? validation} />
      {plan && (
        <>
          <p>
            Revision {plan.bundle.source_revision} · {plan.files.size} active Pokémon. Original
            OHPKM takes precedence over canonical OHPKM, without reserialization. Historical Pokedex
            data, nullable names, folder UUIDs and current selections are preserved.
          </p>
          {plan.collisions.length > 0 && (
            <div role="alert">
              <p>
                Folder export is blocked by embedded-ID collisions. A different filename cannot
                represent independent copies. For each identity explicitly choose one existing
                server copy and one valid destination. Every other copy and omitted placement is
                disclosed in the manifest; all copies remain in the companion lossless JSON bundle.
              </p>
              {plan.collisions.map((collision) => (
                <CopySelector
                  key={collision.openhome_id}
                  collision={collision}
                  plan={plan}
                  value={choices[collision.openhome_id]}
                  onChange={(value) =>
                    setChoices((current) => ({ ...current, [collision.openhome_id]: value }))
                  }
                />
              ))}
            </div>
          )}
          <Flex gap="2" wrap="wrap">
            <Button
              type="button"
              disabled={download.busy || !allChosen}
              onClick={() => (preview.data?.collisions.length ? setConfirm(true) : writeArchive())}
            >
              Download OpenHome folder ZIP
            </Button>
            <Button type="button" variant="soft" disabled={download.busy} onClick={preview.clear}>
              Discard export preview
            </Button>
          </Flex>
        </>
      )}
      {confirm && (
        <ConfirmAction
          title="Export only the selected folder copies?"
          action="Export selected copies and lossless companion"
          onCancel={() => setConfirm(false)}
          onConfirm={writeArchive}
          busy={download.busy}
        >
          The upstream storage folder cannot preserve server copy multiplicity. Omitted UUIDs and
          placements are listed outside the upstream creature identifiers. The included server JSON
          companion retains all records, original binaries, backups and archived artifacts; upstream
          OpenHome does not read that companion wrapper directly.
        </ConfirmAction>
      )}
      {download.busy && <p role="status">Building verified folder ZIP…</p>}
      {download.data && <p role="status">{download.data}</p>}
      <FailureNotice failure={download.failure} />
    </section>
  )
}

function CopySelector({
  collision,
  plan,
  value,
  onChange,
}: {
  collision: FolderCollision
  plan: FolderExportPlan
  value?: CopyChoice
  onChange: (value: CopyChoice) => void
}) {
  const id = useId()
  const firstBank = plan.bundle.content.banks[0]
  const bank =
    plan.bundle.content.banks.find((bank) => bank.id === value?.placement.bank_id) ?? firstBank
  const box = bank.boxes.find((box) => box.id === value?.placement.box_id) ?? bank.boxes[0]
  const setPlacement = (placement: SlotAddress) => {
    if (value) onChange({ ...value, placement })
  }
  return (
    <fieldset className="remote-form">
      <legend>Collision: {collision.openhome_id}</legend>
      <ul>
        {collision.copies.map((copy) => (
          <li key={copy.pokemon_id}>
            <code>{copy.pokemon_id}</code> ·{' '}
            {copy.placement
              ? `${copy.placement.bank_id}/${copy.placement.box_id}, slot ${copy.placement.slot + 1}`
              : 'Unplaced'}
          </li>
        ))}
      </ul>
      <label htmlFor={`${id}-copy`}>Server copy to include</label>
      <select
        id={`${id}-copy`}
        value={value?.pokemon_id ?? ''}
        onChange={(event) => {
          const copy = collision.copies.find((copy) => copy.pokemon_id === event.target.value)
          if (copy)
            onChange({
              pokemon_id: copy.pokemon_id,
              placement: copy.placement ?? { bank_id: bank.id, box_id: box.id, slot: 0 },
            })
        }}
      >
        <option value="" disabled>
          Explicitly select one copy
        </option>
        {collision.copies.map((copy) => (
          <option key={copy.pokemon_id} value={copy.pokemon_id}>
            {copy.pokemon_id}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-bank`}>Export destination bank</label>
      <select
        id={`${id}-bank`}
        value={bank.id}
        disabled={!value}
        onChange={(event) => {
          const selected = plan.bundle.content.banks.find((bank) => bank.id === event.target.value)
          if (selected)
            setPlacement({ bank_id: selected.id, box_id: selected.boxes[0].id, slot: 0 })
        }}
      >
        {plan.bundle.content.banks.map((bank) => (
          <option key={bank.id} value={bank.id}>
            {bank.name}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-box`}>Export destination box</label>
      <select
        id={`${id}-box`}
        value={box.id}
        disabled={!value}
        onChange={(event) => {
          const selected = bank.boxes.find((box) => box.id === event.target.value)
          if (selected) setPlacement({ bank_id: bank.id, box_id: selected.id, slot: 0 })
        }}
      >
        {bank.boxes.map((box) => (
          <option key={box.id} value={box.id}>
            {box.name}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-slot`}>Export destination slot (1–30)</label>
      <input
        id={`${id}-slot`}
        type="number"
        min={1}
        max={30}
        disabled={!value}
        value={(value?.placement.slot ?? 0) + 1}
        onChange={(event) => {
          const number = Number(event.target.value)
          if (Number.isSafeInteger(number) && number >= 1 && number <= 30)
            setPlacement({ bank_id: bank.id, box_id: box.id, slot: number - 1 })
        }}
      />
    </fieldset>
  )
}
