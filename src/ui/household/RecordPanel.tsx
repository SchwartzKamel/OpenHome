import {
  decodeBytes,
  RemoteError,
  type GamePokemonFormat,
  type PokemonExportRequest,
  type PokemonExportResult,
  type PokemonRecord,
  type PokemonView,
} from '@openhome-core/remote'
import { readOhpkm } from '@openhome-core/remote/identity'
import { Moves } from '@openhome-core/resources'
import { AbilityIndex } from '@pkm-rs/pkg'
import { useEffect, useMemo, useRef, useState } from 'react'
import { placement, reserved } from './model'
import { PokemonSummary } from './PokemonSummary'
import { Diagnostics } from './feedback'
import { useHousehold, usePrivateDraft } from './workspace'

interface ExportOwner {
  recordId: string
  token: number
  controls: string
}
interface ExportPreview extends ExportOwner {
  result: PokemonExportResult
  kind: string
}

export function RecordPanel({ record }: { record: PokemonRecord }) {
  const { backend, data, connection, locked, stage, local, report, isCurrent, announce } =
    useHousehold()
  const [detail, setDetail] = useState<PokemonView>()
  const [identity, setIdentity] = useState('')
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [label, setLabel] = useState('')
  const [archive, setArchive] = useState(false)
  const [original, setOriginal] = useState('')
  const [originalChanged, setOriginalChanged] = useState(false)
  const [target, setTarget] = useState<GamePokemonFormat>()
  const [allowLossy, setAllowLossy] = useState(false)
  const [preview, setPreview] = useState<ExportPreview>()
  const exportLease = useRef({ active: true, epoch: 0 })
  const pokemonId = record.id
  const { species, form, nickname, level, shiny } = record.observed
  const artifactKey = record.original_artifact_ids.join(',')
  const originalIds = useMemo(() => new Set(artifactKey.split(',')), [artifactKey])
  const address = data && placement(data.vault.content, record.id)
  const unavailable = !!data && reserved(data.vault.reservations, record.id, address ?? undefined)
  const editBlocked = locked || unavailable || (!connection.coherent && !connection.editing)
  const formats = [
    ...new Set(
      connection.status?.engine.capabilities
        .filter(
          (capability) =>
            capability.operation === 'convert_pkm' && capability.input_format === 'ohpkm'
        )
        .flatMap((capability) => capability.output_formats)
        .filter((format): format is GamePokemonFormat => format !== 'ohpkm') ?? []
    ),
  ]
  const selectedTarget = target && formats.includes(target) ? target : formats[0]
  const controls = JSON.stringify([pokemonId, original, selectedTarget, allowLossy])
  const currentControls = useRef(controls)
  currentControls.current = controls
  const ownsExport = (owner: ExportOwner) =>
    isCurrent() &&
    exportLease.current.active &&
    owner.recordId === pokemonId &&
    owner.token === exportLease.current.epoch &&
    owner.controls === currentControls.current
  const currentPreview = preview && ownsExport(preview) ? preview : undefined
  const exportDraft = originalChanged || target !== undefined || allowLossy || !!currentPreview
  usePrivateDraft(`record-options:${pokemonId}`, archive || exportDraft)
  const invalidateExport = () => {
    exportLease.current.epoch++
    setPreview(undefined)
  }
  useEffect(() => {
    const lease = exportLease.current
    lease.active = true
    return () => {
      lease.active = false
      lease.epoch++
    }
  }, [])
  usePrivateDraft(`label-${record.id}`, !!label)

  useEffect(() => {
    let active = true
    setDetailBusy(true)
    setDetailError('')
    void Promise.all([
      backend.api.call('getPokemon', { path: { pokemon_id: pokemonId } }),
      backend.api.call('exportPokemon', {
        path: { pokemon_id: pokemonId },
        body: { representation: 'ohpkm' },
      }),
    ])
      .then(([view, canonical]) => {
        if (!active || !isCurrent()) return
        if (view.data.pokemon.id !== pokemonId || canonical.data.output.format !== 'ohpkm')
          throw new RemoteError(
            'protocol_error',
            'The selected record did not match its canonical response'
          )
        const mon = readOhpkm(decodeBytes(canonical.data.output))
        try {
          if (
            mon.nationalDex !== species ||
            mon.formIndex !== form ||
            mon.nickname !== nickname ||
            mon.getLevel() !== level ||
            mon.isShiny() !== shiny
          ) {
            throw new RemoteError(
              'protocol_error',
              'Canonical binary observations do not match this record'
            )
          }
          setIdentity(mon.openhomeId)
        } finally {
          mon.free()
        }
        setDetail(view.data)
        setOriginal((current) =>
          view.data.artifacts.some(
            (artifact) =>
              artifact.id === current &&
              artifact.kind === 'original_pkm' &&
              originalIds.has(artifact.id)
          )
            ? current
            : (view.data.artifacts.find(
                (artifact) => artifact.kind === 'original_pkm' && originalIds.has(artifact.id)
              )?.id ?? '')
        )
      })
      .catch((failure: unknown) => {
        if (active && isCurrent()) {
          setDetailError(
            failure instanceof Error ? failure.message : 'Canonical record could not be decoded'
          )
          report(failure)
        }
      })
      .finally(() => {
        if (active && isCurrent()) setDetailBusy(false)
      })
    return () => {
      active = false
    }
  }, [
    backend,
    detailAttempt,
    form,
    isCurrent,
    level,
    nickname,
    originalIds,
    pokemonId,
    report,
    shiny,
    species,
  ])

  const exportPreview = (body: PokemonExportRequest, kind: string) => {
    const owner: ExportOwner = { recordId: pokemonId, token: ++exportLease.current.epoch, controls }
    return local(async () => {
      if (!ownsExport(owner)) return
      setPreview(undefined)
      try {
        const response = await backend.api.call('exportPokemon', {
          path: { pokemon_id: owner.recordId },
          body,
        })
        if (!ownsExport(owner)) return
        decodeBytes(response.data.output)
        if (body.representation === 'ohpkm' && response.data.output.format !== 'ohpkm')
          throw new RemoteError('protocol_error', 'Canonical export returned the wrong format')
        if (
          body.representation === 'converted' &&
          response.data.output.format !== body.target_format
        )
          throw new RemoteError('protocol_error', 'Conversion returned the wrong target format')
        if (
          body.representation === 'converted' &&
          !body.policy.allow_lossy &&
          response.data.losses.length
        )
          throw new RemoteError('protocol_error', 'The server returned losses without consent')
        if (body.representation === 'original') {
          const artifact = detail?.artifacts.find(
            (item) => item.id === body.artifact_id && item.kind === 'original_pkm'
          )
          if (
            !artifact ||
            artifact.sha256 !== response.data.output.sha256 ||
            artifact.byte_length !== response.data.output.byte_length ||
            artifact.format !== response.data.output.format
          )
            throw new RemoteError(
              'checksum_mismatch',
              'Original export did not match the retained exact artifact'
            )
        }
        if (ownsExport(owner)) setPreview({ ...owner, result: response.data, kind })
      } catch (failure) {
        if (ownsExport(owner)) throw failure
      }
    })
  }
  const downloadPreview = (candidate: ExportPreview) =>
    local(async () => {
      if (!ownsExport(candidate)) return
      const bytes = decodeBytes(candidate.result.output)
      if (!ownsExport(candidate)) return
      await backend.files.saveLocalFile(
        bytes,
        `${candidate.recordId}.${candidate.result.output.format}`
      )
      if (ownsExport(candidate))
        announce('Validated artifact download requested. No source save was modified.')
    })

  const ability =
    record.observed.ability === null ? undefined : AbilityIndex.fromIndex(record.observed.ability)
  let abilityName = 'None observed'
  if (ability) {
    try {
      abilityName = ability.name
    } finally {
      ability.free()
    }
  } else if (record.observed.ability !== null) abilityName = `Ability ${record.observed.ability}`

  return (
    <aside className="hh-card hh-record-detail" aria-label="Selected Pokémon">
      <h2>Selected Pokémon</h2>
      <PokemonSummary observed={record.observed} />
      <dl className="hh-facts">
        <dt>Server UUID</dt>
        <dd>
          <code>{record.id}</code>
        </dd>
        <dt>Binary OpenHome ID</dt>
        <dd>
          {detailBusy ? 'Decoding canonical OHPKM…' : identity || 'Unavailable'}
          <small>Not the server UUID. Independent copies may share this identity.</small>
        </dd>
        <dt>Placement</dt>
        <dd>{address ? `Box slot ${address.slot + 1}` : 'Unplaced'}</dd>
        <dt>Moves</dt>
        <dd>
          {record.observed.moves.map((id) => Moves[id]?.name || `Move ${id}`).join(', ') ||
            'None observed'}
        </dd>
        <dt>Ability</dt>
        <dd>{abilityName}</dd>
        <dt>Ribbons</dt>
        <dd>
          {record.observed.ribbons.length
            ? record.observed.ribbons.map((id) => `Ribbon ${id}`).join(', ')
            : 'None observed'}
        </dd>
        <dt>Source generation</dt>
        <dd>{record.observed.source_generation}</dd>
      </dl>
      {detailError && (
        <p role="alert">
          {detailError}{' '}
          <button
            disabled={locked || detailBusy}
            onClick={() => setDetailAttempt((attempt) => attempt + 1)}
          >
            Retry canonical details
          </button>
        </p>
      )}
      {unavailable && (
        <p role="status">
          Reserved by an active trade/transfer; metadata and placement cannot change.
        </p>
      )}
      <section aria-label="Personal metadata">
        <h3>Favorites and labels</h3>
        <button
          disabled={editBlocked}
          aria-pressed={record.metadata.favorite}
          onClick={() =>
            void stage([
              {
                op: 'metadata_put',
                metadata: { ...record.metadata, favorite: !record.metadata.favorite },
              },
            ])
          }
        >
          {record.metadata.favorite ? '★ Remove favorite' : '☆ Favorite'}
        </button>
        <ul className="hh-labels">
          {record.metadata.tags.map((tag) => (
            <li key={tag}>
              {tag}
              <button
                aria-label={`Remove label ${tag}`}
                disabled={editBlocked}
                onClick={() =>
                  void stage([
                    {
                      op: 'metadata_put',
                      metadata: {
                        ...record.metadata,
                        tags: record.metadata.tags.filter((item) => item !== tag),
                      },
                    },
                  ])
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <form
          className="hh-toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            void stage([
              {
                op: 'metadata_put',
                metadata: { ...record.metadata, tags: [...record.metadata.tags, label.trim()] },
              },
            ]).then((ok) => {
              if (ok && isCurrent()) setLabel('')
            })
          }}
        >
          <label>
            New label
            <input
              value={label}
              maxLength={32}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button
            disabled={
              editBlocked ||
              !label.trim() ||
              record.metadata.tags.includes(label.trim()) ||
              record.metadata.tags.length >= 16
            }
          >
            Stage label
          </button>
        </form>
        <p className="hh-help">
          Favorite/labels persist through metadata_put when you Save changes. Personal metadata
          resets on trade acquisition; the server's acquired record is authoritative.
        </p>
      </section>
      <section aria-label="Export Pokémon">
        <h3>Export exact bytes or convert</h3>
        <label>
          Original artifact
          <select
            value={original}
            onChange={(event) => {
              invalidateExport()
              setOriginal(event.target.value)
              setOriginalChanged(true)
            }}
          >
            {!original && <option value="">No original PKM available</option>}
            {detail?.artifacts
              .filter(
                (artifact) =>
                  artifact.kind === 'original_pkm' &&
                  record.original_artifact_ids.includes(artifact.id)
              )
              .map((artifact) => (
                <option key={artifact.id} value={artifact.id}>
                  {artifact.format} · {artifact.byte_length} bytes · {artifact.sha256.slice(0, 12)}
                </option>
              ))}
          </select>
        </label>
        <div className="hh-toolbar">
          <button
            disabled={locked || !original || !detail}
            onClick={() =>
              void exportPreview(
                { representation: 'original', artifact_id: original },
                'Exact original'
              )
            }
          >
            Preview exact original
          </button>
          <button
            disabled={locked}
            onClick={() => void exportPreview({ representation: 'ohpkm' }, 'Canonical OHPKM')}
          >
            Preview canonical OHPKM
          </button>
        </div>
        <p className="hh-help">
          Original means the exact retained input/extracted PKM, including original length and
          SHA-256. Canonical OHPKM is not a universal exact original backup. Whole source saves
          remain private to their source owner.
        </p>
        <label>
          Conversion target
          <select
            value={selectedTarget ?? ''}
            disabled={!formats.length}
            onChange={(event) => {
              invalidateExport()
              setTarget(formats.find((format) => format === event.target.value))
              setAllowLossy(false)
            }}
          >
            {!formats.length && <option value="">No conversions advertised</option>}
            {formats.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="hh-check">
          <input
            type="checkbox"
            checked={allowLossy}
            onChange={(event) => {
              invalidateExport()
              setAllowLossy(event.target.checked)
            }}
          />
          I explicitly allow lossy conversion for this Pokémon/target and will review the returned
          diagnostics before downloading.
        </label>
        <button
          disabled={locked || !selectedTarget}
          onClick={() => {
            if (selectedTarget)
              void exportPreview(
                {
                  representation: 'converted',
                  target_format: selectedTarget,
                  policy: { allow_lossy: allowLossy },
                },
                'Converted game PKM'
              )
          }}
        >
          Preview converted PKM
        </button>
        <button
          disabled={!exportDraft}
          onClick={() => {
            invalidateExport()
            setTarget(undefined)
            setAllowLossy(false)
            setOriginalChanged(false)
            setOriginal(
              detail?.artifacts.find(
                (artifact) => artifact.kind === 'original_pkm' && originalIds.has(artifact.id)
              )?.id ?? ''
            )
          }}
        >
          Clear export draft
        </button>
        {currentPreview && (
          <div className="hh-result">
            <h4>{currentPreview.kind}</h4>
            <p>
              {currentPreview.result.output.format} · {currentPreview.result.output.byte_length}{' '}
              verified bytes
            </p>
            <code className="hh-digest">{currentPreview.result.output.sha256}</code>
            <Diagnostics
              diagnostics={currentPreview.result.losses}
              empty="No losses reported for this representation."
            />
            <button disabled={locked} onClick={() => void downloadPreview(currentPreview)}>
              Download validated artifact
            </button>
          </div>
        )}
        <p className="hh-help">
          No universal legality, Nintendo signing, or official HOME compatibility claim.
        </p>
      </section>
      <details>
        <summary>Archive this active record</summary>
        <label className="hh-check">
          <input
            type="checkbox"
            checked={archive}
            onChange={(event) => setArchive(event.target.checked)}
          />
          Remove this active record and its placements on Save; retain original artifacts on the
          server.
        </label>
        <button
          disabled={editBlocked || !archive}
          onClick={() => void stage([{ op: 'pokemon_delete', pokemon_id: record.id }])}
        >
          Stage archival
        </button>
      </details>
    </aside>
  )
}
