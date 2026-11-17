import {
  pokemonInput,
  RemoteError,
  saveInput,
  type ExtractedPokemon,
  type PokemonRecord,
  type SaveInput,
  type SaveInspectResult,
  type SaveFamily,
  type SaveSlot,
  type SaveSlotPreview,
} from '@openhome-core/remote'
import { useState } from 'react'
import { saveSlotKey, saveSlotLabel, vaultTag } from './model'
import { PokemonSummary } from './PokemonSummary'
import { TransferPanel } from './TransferPanel'
import { FileUpload, pokemonFormats, saveFamilies, type Upload } from './uploads'
import { useHousehold, usePrivateDraft } from './workspace'

export interface InspectedSource {
  input: SaveInput
  detected: SaveInspectResult['detected']
}
type OccupiedSlot = { location: SaveSlot; pokemon: ExtractedPokemon }
function occupied(slot: SaveSlotPreview): slot is OccupiedSlot {
  return slot.pokemon !== null
}
const scopeNotes: Partial<Record<SaveFamily, string>> = {
  gen1: 'Checked-in evidence covers International/Japanese Blue in-memory preparation, not physical cartridges or VC archive writes.',
  gen2: 'Checked-in evidence covers International/Japanese Crystal, not Gold/Silver. International active-box editing has an unverified synchronization limit and fails explicitly.',
  gen4: 'Checked-in fixtures cover Pearl, Platinum and HeartGold; do not infer every title/language variant.',
  gen5: 'Checked-in fixtures cover Black/White, not B2/W2.',
  gen6: 'Bounded XY PC interoperability only: not ORAS, full live-save/trainer/header validity, or hardware certification.',
}

export function ImportPanel({
  selected,
  onAcquired,
}: {
  selected?: PokemonRecord
  onAcquired: (id: string) => void
}) {
  return (
    <section aria-label="Import and save workbench">
      <h2>Copy into your vault</h2>
      <p className="hh-help">
        This copies Pokémon; it does not edit the source. Original bytes are retained by the server
        after an acknowledged COPY. Imported Pokémon appear unplaced; choose an empty bank slot and
        Save changes to place them.
      </p>
      <RawImport onAcquired={onAcquired} />
      <SaveWorkbench selected={selected} onAcquired={onAcquired} />
    </section>
  )
}

function RawImport({ onAcquired }: { onAcquired: (id: string) => void }) {
  const {
    backend,
    connection,
    data,
    locked,
    durableBlocked,
    mutate,
    refresh,
    announce,
    isCurrent,
  } = useHousehold()
  const [upload, setUpload] = useState<Upload>()
  const [hint, setHint] = useState<'auto' | (typeof pokemonFormats)[number]>('auto')
  const [expectedSha, setExpectedSha] = useState('')
  const hasDraft = !!upload || hint !== 'auto' || !!expectedSha.trim()
  usePrivateDraft('pkm-copy', hasDraft)
  const discard = () => {
    setUpload(undefined)
    setExpectedSha('')
    setHint('auto')
  }
  const ambiguous = !!upload && [136, 236].includes(upload.bytes.length) && hint === 'auto'
  const supported = new Set(
    connection.status?.engine.capabilities
      .filter((capability) => capability.operation === 'import_pkm')
      .map((capability) => capability.input_format)
  )
  const checksumMatches = !expectedSha.trim() || upload?.sha256 === expectedSha.trim().toLowerCase()
  const copy = () => {
    if (!upload || !data || ambiguous || !checksumMatches) return
    const input = pokemonInput(upload.bytes, hint)
    void mutate(
      'COPY PKM/OHPKM',
      () =>
        backend.api.prepare('importPokemon', {
          ifMatch: vaultTag(data.vault.revision),
          body: { kind: 'pkm', input, destination: null },
        }),
      async (response) => {
        discard()
        if (response.data.pokemon.length !== 1)
          throw new RemoteError(
            'protocol_error',
            'COPY was acknowledged but returned an unexpected record count. Refresh; do not make a new copy.'
          )
        announce(
          'One Pokémon copied and retained unplaced. The source was not edited. Choose an empty bank slot to stage placement.'
        )
        await refresh()
        if (isCurrent()) onAcquired(response.data.pokemon[0].id)
      }
    )
  }
  return (
    <section className="hh-card" aria-label="PKM COPY import">
      <h3>Raw PKM / OHPKM</h3>
      <FileUpload
        label="PKM or OHPKM file"
        maximum={Math.min(connection.status?.limits.pkm_bytes ?? 1_048_576, 1_048_576)}
        accept=".pkm,.ohpkm,.pk1,.pk2,.pk3,.pk4,.pk5,.pk6,.pk7,.pb7,.pk8,.pb8,.pa8,.pk9,.pa9"
        upload={upload}
        onUpload={(value) => {
          setUpload(value)
          setExpectedSha('')
          setHint('auto')
        }}
        disabled={durableBlocked}
      />
      <div className="hh-form-grid">
        <label>
          Validated format hint
          <select
            value={hint}
            disabled={durableBlocked}
            onChange={(event) =>
              setHint(pokemonFormats.find((format) => format === event.target.value) ?? 'auto')
            }
          >
            <option value="auto">Detect from bytes (not filename)</option>
            {pokemonFormats.map((format) => (
              <option key={format} value={format} disabled={!supported.has(format)}>
                {format.toUpperCase()}
                {supported.has(format) ? '' : ' — not advertised'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expected SHA-256 (optional)
          <input
            maxLength={64}
            pattern="[0-9a-fA-F]{64}"
            value={expectedSha}
            disabled={durableBlocked}
            onChange={(event) => setExpectedSha(event.target.value)}
          />
        </label>
      </div>
      {ambiguous && (
        <p className="hh-warning" role="alert">
          This byte length can be PK4 or PK5. Explicitly choose a validated PK4/PK5 format hint. The
          filename is never used to guess.
        </p>
      )}
      {!checksumMatches && (
        <p className="hh-error" role="alert">
          Expected SHA-256 does not match the selected bytes. COPY is blocked.
        </p>
      )}
      <button disabled={durableBlocked || !upload || ambiguous || !checksumMatches} onClick={copy}>
        COPY file into vault
      </button>
      <button disabled={locked || !hasDraft} onClick={discard}>
        Discard PKM COPY draft
      </button>
      {connection.editing && (
        <p>Save or roll back staged vault edits before a separate COPY import.</p>
      )}
    </section>
  )
}

function SaveWorkbench({
  selected,
  onAcquired,
}: {
  selected?: PokemonRecord
  onAcquired: (id: string) => void
}) {
  const {
    backend,
    connection,
    data,
    locked,
    durableBlocked,
    local,
    mutate,
    refresh,
    report,
    isCurrent,
    announce,
  } = useHousehold()
  const [upload, setUpload] = useState<Upload>()
  const [hint, setHint] = useState<'auto' | (typeof saveFamilies)[number]>('auto')
  const [source, setSource] = useState<InspectedSource>()
  const [pages, setPages] = useState<SaveInspectResult[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [selection, setSelection] = useState<ReadonlyMap<string, OccupiedSlot>>(new Map())
  const [destination, setDestination] = useState<SaveSlot>()
  const [expectedSha, setExpectedSha] = useState('')
  const hasDraft =
    !!upload ||
    hint !== 'auto' ||
    !!expectedSha.trim() ||
    !!source ||
    selection.size > 0 ||
    !!destination
  usePrivateDraft('save-copy', hasDraft)
  const page = pages[pageIndex]
  const checksumMatches = !expectedSha.trim() || upload?.sha256 === expectedSha.trim().toLowerCase()
  const supported = new Set(
    connection.status?.engine.capabilities
      .filter((capability) => capability.operation === 'inspect_save')
      .map((capability) => capability.input_format)
  )
  const reset = () => {
    setSource(undefined)
    setPages([])
    setPageIndex(0)
    setSelection(new Map())
    setDestination(undefined)
  }
  const inspect = (next = false) =>
    local(async () => {
      if (!upload || !checksumMatches) return
      const input = next && source ? source.input : saveInput(upload.bytes, hint)
      const cursor = next ? page?.next_cursor : undefined
      if (next && !cursor) return
      const response = await backend.api.call('inspectSave', {
        body: { input, limit: 30, ...(cursor && { cursor }) },
      })
      if (!isCurrent()) return
      if (
        response.data.save_sha256 !== input.sha256 ||
        (next &&
          source &&
          JSON.stringify(source.detected) !== JSON.stringify(response.data.detected))
      )
        throw new RemoteError(
          'checksum_mismatch',
          'Inspection page is not bound to the exact selected save and geometry'
        )
      if (
        next &&
        response.data.next_cursor &&
        pages.some((item) => item.next_cursor === response.data.next_cursor)
      )
        throw new RemoteError('protocol_error', 'The server repeated a save-inspection cursor')
      if (next) {
        setPages((previous) => [...previous, response.data])
        setPageIndex((index) => index + 1)
      } else {
        setSource({ input, detected: response.data.detected })
        setPages([response.data])
        setPageIndex(0)
        setSelection(new Map())
        setDestination(undefined)
      }
    })
  const toggle = (slot: OccupiedSlot) => {
    const key = saveSlotKey(slot.location)
    const next = new Map(selection)
    if (next.has(key)) next.delete(key)
    else {
      if (next.size >= 30) {
        report(new RemoteError('limit_exceeded', 'Choose at most 30 occupied save slots per COPY.'))
        return
      }
      next.set(key, slot)
    }
    setSelection(next)
  }
  const copy = () => {
    if (!source || !data || !selection.size) return
    const selections = [...selection.values()].map((slot) => ({
      source: slot.location,
      expected_pokemon_sha256: slot.pokemon.original.sha256,
      destination: null,
    }))
    void mutate(
      `COPY ${selections.length} selected save Pokémon`,
      () =>
        backend.api.prepare('importPokemon', {
          ifMatch: vaultTag(data.vault.revision),
          body: { kind: 'save', input: source.input, selections },
        }),
      async (response) => {
        setSelection(new Map())
        if (response.data.pokemon.length !== selections.length)
          throw new RemoteError(
            'protocol_error',
            'COPY acknowledged an unexpected count; refresh instead of creating another copy.'
          )
        announce(
          `${selections.length} selected Pokémon copied unplaced. The exact complete source save was retained privately; the source file was not edited.`
        )
        await refresh()
        if (isCurrent() && response.data.pokemon[0]) onAcquired(response.data.pokemon[0].id)
      }
    )
  }
  return (
    <section className="hh-card" aria-label="Complete save workbench">
      <h3>Complete save inspection and selected COPY</h3>
      <FileUpload
        label="Complete save file"
        maximum={Math.min(connection.status?.limits.save_bytes ?? 16_777_216, 16_777_216)}
        upload={upload}
        disabled={locked}
        onUpload={(value) => {
          setUpload(value)
          setExpectedSha('')
          reset()
        }}
      />
      <div className="hh-form-grid">
        <label>
          Save family hint
          <select
            value={hint}
            disabled={locked}
            onChange={(event) => {
              setHint(saveFamilies.find((family) => family === event.target.value) ?? 'auto')
              reset()
            }}
          >
            <option value="auto">Detect from bytes (not filename)</option>
            {saveFamilies.map((family) => (
              <option key={family} value={family} disabled={!supported.has(family)}>
                {family}
                {supported.has(family) ? '' : ' — not advertised'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Save expected SHA-256 (optional)
          <input
            maxLength={64}
            value={expectedSha}
            disabled={locked}
            onChange={(event) => {
              setExpectedSha(event.target.value)
              reset()
            }}
          />
        </label>
      </div>
      {!checksumMatches && (
        <p role="alert" className="hh-error">
          Expected SHA-256 does not match this complete save.
        </p>
      )}
      <button disabled={locked || !upload || !checksumMatches} onClick={() => void inspect()}>
        Inspect complete save
      </button>
      <p className="hh-help">
        Read-only inspection uploads bytes, not local save paths. Unsupported/encrypted/ambiguous
        input fails visibly. Advertised family support is not support for every
        title/language/variant.
      </p>
      {page && source && (
        <>
          <p role="status">
            {page.detected.family} · generation {page.detected.generation} ·{' '}
            {page.detected.box_count} boxes × {page.detected.slots_per_box} slots ·{' '}
            {page.slot_count} inspectable slots · page {pageIndex + 1}
          </p>
          <p className="hh-warning">
            {scopeNotes[source.detected.family] ??
              'No variant-level fixture certification is implied for this family.'}{' '}
            These scope notes are not a live attestation of the server build. Native writes stay
            disabled.
          </p>
          <p className="hh-help">
            Select occupied slots across pages (up to 30). Empty slots may be selected separately as
            withdrawal destinations. Only checked Pokémon are copied.
          </p>
          <div className="hh-save-slots">
            {page.slots.map((slot) => (
              <div key={saveSlotKey(slot.location)} className="hh-save-slot">
                {occupied(slot) ? (
                  <label className="hh-check">
                    <input
                      type="checkbox"
                      checked={selection.has(saveSlotKey(slot.location))}
                      disabled={locked}
                      onChange={() => toggle(slot)}
                      aria-label={`Copy ${saveSlotLabel(slot.location)}`}
                    />
                    <span>
                      {saveSlotLabel(slot.location)}
                      <PokemonSummary observed={slot.pokemon.observed} />
                    </span>
                  </label>
                ) : (
                  <label className="hh-check">
                    <input
                      type="radio"
                      name="hh-withdraw-destination"
                      checked={
                        !!destination && saveSlotKey(destination) === saveSlotKey(slot.location)
                      }
                      disabled={locked}
                      onChange={() => setDestination(slot.location)}
                      aria-label={`Withdraw into ${saveSlotLabel(slot.location)}`}
                    />
                    {saveSlotLabel(slot.location)} — empty
                  </label>
                )}
              </div>
            ))}
          </div>
          {!page.slots.length && <p>No inspectable slots returned.</p>}
          <div className="hh-toolbar">
            <button
              disabled={locked || pageIndex === 0}
              onClick={() => setPageIndex((index) => index - 1)}
            >
              Previous save page
            </button>
            <button
              disabled={locked || (pageIndex === pages.length - 1 && !page.next_cursor)}
              onClick={() => {
                if (pageIndex < pages.length - 1) setPageIndex((index) => index + 1)
                else void inspect(true)
              }}
            >
              Next save page
            </button>
          </div>
          <p>
            {selection.size} occupied slot{selection.size === 1 ? '' : 's'} selected. This copies,
            does not edit the source.
          </p>
          {!!selection.size && (
            <ul>
              {[...selection.values()].map((slot) => (
                <li key={saveSlotKey(slot.location)}>
                  {saveSlotLabel(slot.location)} ·{' '}
                  {slot.pokemon.observed.nickname || `Species ${slot.pokemon.observed.species}`}
                </li>
              ))}
            </ul>
          )}
          <div className="hh-toolbar">
            <button disabled={durableBlocked || !selection.size} onClick={copy}>
              COPY selected Pokémon into vault
            </button>
            <button disabled={locked || !selection.size} onClick={() => setSelection(new Map())}>
              Clear save selection
            </button>
          </div>
        </>
      )}
      {!page && (
        <p>
          No save inspection loaded. No Pokémon will be invented for an unreadable or empty source.
        </p>
      )}
      <button
        disabled={locked || !hasDraft}
        onClick={() => {
          setUpload(undefined)
          setExpectedSha('')
          setHint('auto')
          reset()
        }}
      >
        Discard complete-save draft
      </button>
      <p className="hh-help">
        This clears client-retained bytes, inspection and unsent selections, not acknowledged copies
        or transfers.
      </p>
      <TransferPanel source={source} selected={selected} destination={destination} />
    </section>
  )
}
