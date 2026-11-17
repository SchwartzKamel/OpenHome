import {
  decodeBytes,
  newId,
  parseWire,
  RemoteError,
  type GamePokemonFormat,
  type PokemonExportResult,
  type PokemonRecord,
  type SaveBytes,
  type SaveFamily,
  type SaveSlot,
  type TransferView,
} from '@openhome-core/remote'
import { useState } from 'react'
import type { InspectedSource } from './ImportPanel'
import { Diagnostics } from './feedback'
import { reserved, saveSlotKey, saveSlotLabel, vaultTag } from './model'
import { PokemonSummary } from './PokemonSummary'
import { FileUpload, type Upload } from './uploads'
import { useHousehold, usePrivateDraft } from './workspace'

const gameFormats: Partial<Record<SaveFamily, GamePokemonFormat>> = {
  gen1: 'pk1',
  gen2: 'pk2',
  gen3: 'pk3',
  gen4: 'pk4',
  gen5: 'pk5',
  gen6: 'pk6',
  gen7: 'pk7',
  lets_go: 'pb7',
  sword_shield: 'pk8',
  bdsp: 'pb8',
  legends_arceus: 'pa8',
  scarlet_violet: 'pk9',
  legends_za: 'pa9',
}
function terminal(view: TransferView): boolean {
  return ['FINALIZED', 'CANCELLED', 'EXPIRED'].includes(view.transfer.state)
}
function validatedArtifact(view: TransferView, which: 'original' | 'prepared'): SaveBytes {
  const artifact = parseWire('SaveBytes', view.artifact)
  const expected = which === 'original' ? view.transfer.original_save : view.transfer.prepared_save
  if (
    artifact.sha256 !== expected.sha256 ||
    artifact.byte_length !== expected.byte_length ||
    artifact.family !== expected.format
  )
    throw new RemoteError(
      'checksum_mismatch',
      'Transfer artifact does not match the retained manifest'
    )
  decodeBytes(artifact)
  return artifact
}

export function TransferPanel({
  source,
  selected,
  destination,
}: {
  source?: InspectedSource
  selected?: PokemonRecord
  destination?: SaveSlot
}) {
  const {
    backend,
    data,
    connection,
    locked,
    durableBlocked,
    local,
    mutate,
    refresh,
    announce,
    isCurrent,
  } = useHousehold()
  const [consentFor, setConsentFor] = useState('')
  const [conversion, setConversion] = useState<{ key: string; result: PokemonExportResult }>()
  const [transfer, setTransfer] = useState<TransferView>()
  const [lookupId, setLookupId] = useState('')
  const [currentFile, setCurrentFile] = useState<Upload>()
  const [backupFile, setBackupFile] = useState<Upload>()
  const [recoveryRecorded, setRecoveryRecorded] = useState(false)
  const key = `${source?.input.sha256 ?? ''}:${selected?.id ?? ''}:${destination ? saveSlotKey(destination) : ''}`
  const consent = consentFor === key
  const preview = conversion?.key === key ? conversion.result : undefined
  const target = source && gameFormats[source.detected.family]
  const supported =
    !!source &&
    !!connection.status?.engine.capabilities.some(
      (capability) =>
        capability.operation === 'prepare_save' &&
        capability.input_format === source.detected.family
    )
  const pendingTransfer = !!transfer && !terminal(transfer)
  const originalSha = transfer?.transfer.original_save.sha256
  const verifiedOriginal =
    !!originalSha && currentFile?.sha256 === originalSha && backupFile?.sha256 === originalSha
  const lookupDirty = !!lookupId.trim() && lookupId.trim() !== transfer?.transfer.id
  const inputDraft =
    lookupDirty || !!currentFile || !!backupFile || (!!source && (consent || !!preview))
  usePrivateDraft('transfer-inputs', inputDraft)
  usePrivateDraft('transfer-recovery', pendingTransfer && !recoveryRecorded)

  const previewConversion = () =>
    local(async () => {
      if (!selected || !target) return
      const response = await backend.api.call('exportPokemon', {
        path: { pokemon_id: selected.id },
        body: {
          representation: 'converted',
          target_format: target,
          policy: { allow_lossy: consent },
        },
      })
      if (!isCurrent()) return
      if (response.data.output.format !== target || (!consent && response.data.losses.length))
        throw new RemoteError(
          'protocol_error',
          'Withdrawal conversion did not honor the selected target/policy'
        )
      decodeBytes(response.data.output)
      setConversion({ key, result: response.data })
    })

  const prepare = () => {
    if (!source || !selected || !destination || !data || !preview) return
    const transferId = newId()
    void mutate(
      'Prepare withdrawal preview',
      () =>
        backend.api.prepare('prepareTransfer', {
          ifMatch: vaultTag(data.vault.revision),
          body: {
            transfer_id: transferId,
            original_save: source.input,
            source: 'sd_export',
            plan: {
              direction: 'withdraw',
              entries: [{ pokemon_id: selected.id, destination, policy: { allow_lossy: consent } }],
            },
          },
        }),
      async (response) => {
        const view = parseWire('TransferView', response.data)
        setLookupId(view.transfer.id)
        setTransfer(view)
        setRecoveryRecorded(false)
        if (
          view.transfer.id !== transferId ||
          view.transfer.original_save.sha256 !== source.input.sha256
        )
          throw new RemoteError(
            'protocol_error',
            'Prepared transfer did not match its stable ID/original source; query recovery before proceeding.'
          )
        validatedArtifact(view, 'prepared')
        announce(
          'Validated save copy prepared on the server. No local file was written and no local_applied/finalize action was sent.'
        )
        await refresh()
      }
    )
  }

  const readTransfer = (artifact?: 'original' | 'prepared') =>
    local(async () => {
      const id = parseWire('Id', lookupId.trim())
      const response = await backend.api.call('getTransfer', {
        path: { transfer_id: id },
        query: { artifact: artifact ?? 'none' },
      })
      if (!isCurrent()) return
      setTransfer(response.data)
      if (artifact) {
        const bytes = validatedArtifact(response.data, artifact)
        await backend.files.saveLocalFile(
          decodeBytes(bytes),
          `${id}-${artifact}-${bytes.sha256.slice(0, 12)}.sav`
        )
        if (isCurrent())
          announce(
            'Validated save-copy download requested. A download is not proof of backup, write, reopen, or hardware certification.'
          )
      }
      await refresh()
    })

  const cancel = () => {
    if (!transfer || !data || !verifiedOriginal || !currentFile || !backupFile) return
    void mutate(
      'Cancel verified-original transfer',
      () =>
        backend.api.prepare('actOnTransfer', {
          path: { transfer_id: transfer.transfer.id },
          ifMatch: vaultTag(data.vault.revision),
          body: {
            action: 'cancel',
            observed_local_sha256: currentFile.sha256,
            verified_backup_sha256: backupFile.sha256,
          },
        }),
      async (response) => {
        setTransfer(response.data)
        setCurrentFile(undefined)
        setBackupFile(undefined)
        announce(
          'Cancellation acknowledged. Server state is authoritative; no vault Pokémon was optimistically removed.'
        )
        await refresh()
      }
    )
  }

  return (
    <section className="hh-card" aria-label="Verified transfer preview and recovery">
      <h3>Withdraw to a prepared save copy</h3>
      <p className="hh-warning">
        Browser/desktop preview only. Native writes are disabled in this workspace until real
        hardware certification. Downloading never means the original file was written, and never
        sends local_applied or finalize.
      </p>
      {!source && (
        <p>
          Inspect a complete save above, choose an empty destination slot, and select one owned
          vault Pokémon.
        </p>
      )}
      {source && (
        <>
          <p>
            Destination source: {source.detected.family} ·{' '}
            {destination
              ? saveSlotLabel(destination)
              : 'choose an actually empty inspected slot above'}
            .
          </p>
          {selected ? (
            <PokemonSummary observed={selected.observed} />
          ) : (
            <p>Select an owned Pokémon from the Collection tab first.</p>
          )}
          {!supported && (
            <p role="alert">
              This server does not advertise prepare_save for this family. Preparation is
              unavailable.
            </p>
          )}
          <p className="hh-help">
            Preparation reserves the selected server UUID, retains original/prepared saves, and
            returns a validated copy. The authoritative vault record stays owned until a separately
            verified finalization. This workspace deliberately cannot certify that stage.
          </p>
          <label className="hh-check">
            <input
              type="checkbox"
              checked={consent}
              disabled={locked || pendingTransfer}
              onChange={(event) => {
                setConsentFor(event.target.checked ? key : '')
                setConversion(undefined)
              }}
            />
            I explicitly permit lossy conversion for this withdrawal preview and plan, after
            reviewing the returned diagnostics. Original bytes remain retained.
          </label>
          <button
            disabled={locked || !supported || !selected || !target || pendingTransfer}
            onClick={() => void previewConversion()}
          >
            Preview withdrawal conversion
          </button>
          {preview && (
            <Diagnostics diagnostics={preview.losses} empty="No conversion losses reported." />
          )}
          <p className="hh-help">
            These are the format-conversion diagnostics. The frozen transfer response has no
            separate per-field diagnostics; the server additionally validates the resulting save.
            Loss is disallowed unless consent above is checked.
          </p>
          <button
            disabled={
              durableBlocked ||
              !supported ||
              !selected ||
              !destination ||
              !preview ||
              pendingTransfer ||
              (!!data && !!selected && reserved(data.vault.reservations, selected.id))
            }
            onClick={prepare}
          >
            Prepare validated save copy (reserve only)
          </button>
        </>
      )}
      <h4>Recover / refresh an existing transfer</h4>
      <form
        className="hh-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          void readTransfer()
        }}
      >
        <label>
          Transfer recovery UUID
          <input
            required
            value={lookupId}
            disabled={locked || (pendingTransfer && !recoveryRecorded)}
            onChange={(event) => {
              setLookupId(event.target.value)
              setTransfer(undefined)
              setCurrentFile(undefined)
              setBackupFile(undefined)
              setRecoveryRecorded(false)
            }}
          />
        </label>
        <button disabled={locked || !lookupId.trim()}>Refresh transfer state</button>
      </form>
      <button
        disabled={locked || !inputDraft}
        onClick={() => {
          setLookupId(transfer?.transfer.id ?? '')
          setCurrentFile(undefined)
          setBackupFile(undefined)
          setConsentFor('')
          setConversion(undefined)
        }}
      >
        Discard transfer draft inputs
      </button>
      <p className="hh-help">
        Discarding inputs does not cancel an acknowledged transfer or forget its recovery UUID.
      </p>
      {transfer && (
        <div className="hh-result">
          <p>
            <strong>{transfer.transfer.state}</strong> · <code>{transfer.transfer.id}</code>
          </p>
          <p>
            Expires {transfer.transfer.expires_at} · write authorization reported by server:{' '}
            {transfer.transfer.write_authorized ? 'yes (not hardware certification)' : 'no'} ·
            recovery: {transfer.transfer.recovery}
          </p>
          <p>
            Plan: {transfer.transfer.plan.direction}, {transfer.transfer.plan.entries.length}{' '}
            entries.{' '}
            {transfer.transfer.outcome
              ? `Outcome revision ${transfer.transfer.outcome.revision}.`
              : 'No finalization outcome.'}
          </p>
          <dl className="hh-facts">
            <dt>Original SHA-256</dt>
            <dd>
              <code>{transfer.transfer.original_save.sha256}</code>
            </dd>
            <dt>Prepared SHA-256</dt>
            <dd>
              <code>{transfer.transfer.prepared_save.sha256}</code>
            </dd>
          </dl>
          {pendingTransfer && (
            <label className="hh-check">
              <input
                type="checkbox"
                checked={recoveryRecorded}
                onChange={(event) => setRecoveryRecorded(event.target.checked)}
              />
              I recorded this recovery UUID. I understand server reservations survive leaving this
              screen, and a download does not complete this move.
            </label>
          )}
          <div className="hh-toolbar">
            <button disabled={locked} onClick={() => void readTransfer('prepared')}>
              Download validated prepared save copy
            </button>
            <button disabled={locked} onClick={() => void readTransfer('original')}>
              Download retained original save
            </button>
          </div>
          {pendingTransfer && (
            <details>
              <summary>Cancel after verifying the original and a byte-exact backup</summary>
              <p>
                Re-select the actual current local save and an independent original backup. Both
                SHA-256 values must equal the retained original. If the file contains prepared or
                unknown bytes, restore/reconcile outside this preview before cancellation; never
                assert local_applied from a download.
              </p>
              <FileUpload
                label="Current local save for cancellation verification"
                maximum={16_777_216}
                upload={currentFile}
                onUpload={setCurrentFile}
              />
              <FileUpload
                label="Original backup for cancellation verification"
                maximum={16_777_216}
                upload={backupFile}
                onUpload={setBackupFile}
              />
              {(currentFile || backupFile) && !verifiedOriginal && (
                <p role="alert">Both re-read files must match the retained original SHA-256.</p>
              )}
              <button disabled={durableBlocked || !verifiedOriginal} onClick={cancel}>
                Cancel reservation with verified original
              </button>
            </details>
          )}
          {transfer.transfer.state === 'EXPIRED' && (
            <p role="alert">
              Expired preparations never reactivate. Recover the retained original or explicitly
              COPY/import; do not finalize or claim a write succeeded.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
