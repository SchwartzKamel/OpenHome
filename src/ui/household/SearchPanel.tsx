import { RemoteError, type Input, type PokemonPage } from '@openhome-core/remote'
import { useState } from 'react'
import { RecordChoice } from './VaultPanel'
import { useHousehold, usePrivateDraft } from './workspace'

const emptyFilters = JSON.stringify(['', '', false, false, '', ''])

export function SearchPanel({
  selected,
  onSelect,
}: {
  selected: string
  onSelect: (id: string) => void
}) {
  const { backend, data, locked, local, isCurrent } = useHousehold()
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [favorite, setFavorite] = useState(false)
  const [unplaced, setUnplaced] = useState(false)
  const [species, setSpecies] = useState('')
  const [form, setForm] = useState('')
  const [page, setPage] = useState<PokemonPage>()
  const [query, setQuery] = useState<Input<'listPokemon'>['query']>()
  const filters = JSON.stringify([q.trim(), tag.trim(), favorite, unplaced, species, form])
  const [submitted, setSubmitted] = useState(emptyFilters)
  usePrivateDraft('search-filters', filters !== submitted)
  const search = (more: boolean) =>
    local(async () => {
      if (!data) return
      if (form && !species)
        throw new RemoteError('invalid_request', 'A form filter requires a species number.')
      const filter: Input<'listPokemon'>['query'] =
        more && query
          ? {
              ...query,
              ...(page?.next_cursor && { cursor: page.next_cursor }),
            }
          : {
              limit: 30,
              at_revision: data.vault.revision,
              ...(q.trim() && { q: q.trim() }),
              ...(tag.trim() && { tag: tag.trim() }),
              ...(favorite && { favorite: true }),
              ...(unplaced && { unplaced: true }),
              ...(species && { species: Number(species) }),
              ...(form && { form: Number(form) }),
            }
      const response = await backend.api.call('listPokemon', { query: filter })
      if (!isCurrent()) return
      setPage((previous) => ({
        ...response.data,
        items: more && previous ? [...previous.items, ...response.data.items] : response.data.items,
      }))
      setQuery(filter)
      if (!more) setSubmitted(filters)
    })
  return (
    <section aria-label="Search collection" className="hh-card">
      <h2>Search your collection</h2>
      <p className="hh-help">
        Server search combines filters with AND. Text matches nickname/labels (Unicode substring);
        species and form use numeric resource IDs. Only saved metadata is searchable.
      </p>
      <form
        className="hh-form-grid"
        onSubmit={(event) => {
          event.preventDefault()
          void search(false)
        }}
      >
        <label>
          Nickname or label
          <input
            disabled={locked}
            maxLength={128}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
        <label>
          Exact label
          <input
            disabled={locked}
            maxLength={32}
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          />
        </label>
        <label>
          Species ID
          <input
            disabled={locked}
            type="number"
            min={1}
            max={65535}
            value={species}
            onChange={(event) => setSpecies(event.target.value)}
          />
        </label>
        <label>
          Form ID
          <input
            disabled={locked}
            type="number"
            min={0}
            max={65535}
            value={form}
            onChange={(event) => setForm(event.target.value)}
          />
        </label>
        <label className="hh-check">
          <input
            disabled={locked}
            type="checkbox"
            checked={favorite}
            onChange={(event) => setFavorite(event.target.checked)}
          />
          Favorites only
        </label>
        <label className="hh-check">
          <input
            disabled={locked}
            type="checkbox"
            checked={unplaced}
            onChange={(event) => setUnplaced(event.target.checked)}
          />
          Unplaced only
        </label>
        <button disabled={locked || !data}>Search saved collection</button>
        <button
          type="button"
          disabled={locked || filters === emptyFilters}
          onClick={() => {
            setQ('')
            setTag('')
            setFavorite(false)
            setUnplaced(false)
            setSpecies('')
            setForm('')
            setPage(undefined)
            setQuery(undefined)
            setSubmitted(emptyFilters)
          }}
        >
          Clear search filters
        </button>
      </form>
      {page && (
        <>
          <p role="status">
            {page.items.length} results loaded · revision {page.revision}
            {page.revision !== data?.vault.revision
              ? ' — stale; search again before selecting'
              : ''}
          </p>
          {!page.items.length && <p>No matching Pokémon.</p>}
          {page.revision === data?.vault.revision && (
            <div className="hh-record-list">
              {page.items.map((record) => (
                <RecordChoice
                  key={record.id}
                  record={record}
                  selected={selected === record.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
          {page.next_cursor && (
            <button
              disabled={locked || page.revision !== data?.vault.revision}
              onClick={() => void search(true)}
            >
              Load next search page
            </button>
          )}
        </>
      )}
    </section>
  )
}
