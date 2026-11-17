import { RemoteError, type MetadataPage, type ObservedItem } from '@openhome-core/remote'
import { Moves } from '@openhome-core/resources'
import { AbilityIndex, ModernRibbon, ObsoleteRibbon } from '@pkm-rs/pkg'
import { useCallback, useEffect, useRef, useState } from 'react'
import { speciesLabel } from './PokemonSummary'
import { toError, useHousehold } from './workspace'

const kinds = ['species', 'forms', 'moves', 'abilities', 'ribbons'] as const
function observedLabel(item: ObservedItem) {
  if ('species' in item) return speciesLabel(item.species, 'form' in item ? item.form : 0)
  if ('move' in item) return Moves[item.move]?.name || `Move ${item.move}`
  if ('ability' in item) {
    const resource = AbilityIndex.fromIndex(item.ability)
    if (!resource) return `Ability ${item.ability}`
    try {
      return resource.name
    } finally {
      resource.free()
    }
  }
  const name = item.ribbon >= 49 ? ModernRibbon[item.ribbon - 49] : ObsoleteRibbon[item.ribbon - 1]
  return `${typeof name === 'string' ? name : 'Ribbon'} (observed ID ${item.ribbon})`
}

export function TrackerPanel({ active }: { active: boolean }) {
  const { backend, data, connection, isCurrent } = useHousehold()
  const [kind, setKind] = useState<(typeof kinds)[number]>('species')
  const [page, setPage] = useState<MetadataPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<RemoteError>()
  const [attempt, setAttempt] = useState(0)
  const [historyLimit, setHistoryLimit] = useState(30)
  const requestNumber = useRef(0)
  const invalidateRequests = useCallback(() => {
    requestNumber.current++
  }, [])
  const revision = data?.vault.revision
  const load = useCallback(
    async (cursor?: string) => {
      if (revision === undefined) return
      const request = ++requestNumber.current
      setLoading(true)
      setError(undefined)
      try {
        const response = await backend.api.call('getMetadata', {
          query: { kind, at_revision: revision, limit: 30, ...(cursor && { cursor }) },
        })
        if (!isCurrent() || request !== requestNumber.current) return
        if (response.data.revision !== revision || response.data.kind !== kind)
          throw new RemoteError(
            'protocol_error',
            'Tracker page does not match the requested revision/kind'
          )
        setPage((previous) => ({
          ...response.data,
          items:
            cursor && previous?.revision === revision && previous.kind === kind
              ? [...previous.items, ...response.data.items]
              : response.data.items,
        }))
      } catch (failure) {
        if (isCurrent() && request === requestNumber.current) setError(toError(failure))
      } finally {
        if (isCurrent() && request === requestNumber.current) setLoading(false)
      }
    },
    [backend, isCurrent, kind, revision]
  )
  useEffect(() => {
    if (active) {
      setPage(undefined)
      void load()
    }
    return invalidateRequests
  }, [active, attempt, invalidateRequests, load])
  const history = data?.vault.content.openhome_compatibility?.pokedex_history ?? []
  return (
    <section aria-label="Observed collection trackers">
      <h2>Observed collection trackers</h2>
      <p className="hh-warning">
        Observed owned collection only—not official HOME completion. No invented totals or
        completion denominators. Counts come from current canonical observations; reservations do
        not remove records from counts.
      </p>
      <dl className="hh-tracker-counts">
        {kinds.map((item) => (
          <div key={item}>
            <dt>{item}</dt>
            <dd>{data?.vault.pokedex[item] ?? '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="hh-toolbar">
        <label>
          Observed resource
          <select
            value={kind}
            disabled={loading}
            onChange={(event) => {
              setKind(kinds.find((item) => item === event.target.value) ?? 'species')
            }}
          >
            {kinds.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button disabled={loading} onClick={() => setAttempt((value) => value + 1)}>
          Refresh observed metadata
        </button>
      </div>
      {connection.editing && (
        <p>Metadata pages reflect the saved server revision, not unsaved favorite/label edits.</p>
      )}
      {loading && <p role="status">Loading observed {kind}…</p>}
      {error && (
        <p className="hh-error" role="alert">
          {error.code}: {error.message}
          {error.retryAfterSeconds !== undefined
            ? ` · Retry-After ${error.retryAfterSeconds}s`
            : ''}
        </p>
      )}
      {page && (
        <>
          <p>
            Saved revision {page.revision} · {page.favorite_count} favorites · {page.items.length}{' '}
            observed {kind} entries loaded
          </p>
          <div className="hh-labels">
            {page.tags.map((entry) => (
              <span key={entry.tag}>
                {entry.tag}: {entry.count}
              </span>
            ))}
          </div>
          {!page.items.length && <p>No observed {kind} in your collection.</p>}
          <ul className="hh-observed-list">
            {page.items.map((item, index) => (
              <li key={`${kind}:${index}`}>
                {observedLabel(item)} <strong>{item.count}</strong> owned record
                {item.count === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
          {page.next_cursor && (
            <button
              disabled={loading || page.revision !== revision}
              onClick={() => void load(page.next_cursor ?? undefined)}
            >
              Load next observed page
            </button>
          )}
        </>
      )}
      <details className="hh-card">
        <summary>Preserved legacy OpenHome Pokédex history ({history.length} entries)</summary>
        <p>
          This separate historical compatibility data survives layout changes and metadata saves. It
          is not replaced by current-owned trackers.
        </p>
        <ul>
          {history.slice(0, historyLimit).map((entry) => (
            <li key={`${entry.species}:${entry.form}`}>
              {speciesLabel(entry.species, entry.form)} · {entry.level} · {entry.games.join(', ')}
            </li>
          ))}
        </ul>
        {history.length > historyLimit && (
          <button onClick={() => setHistoryLimit((count) => count + 30)}>
            Show more preserved history
          </button>
        )}
      </details>
    </section>
  )
}
