import type { RemoteBackend } from '@openhome-core/remote'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ImportPanel } from './ImportPanel'
import { RecordPanel } from './RecordPanel'
import { SearchPanel } from './SearchPanel'
import { SupportPanel } from './SupportPanel'
import { TrackerPanel } from './TrackerPanel'
import { TradePanel } from './TradePanel'
import { VaultPanel } from './VaultPanel'
import { WorkspaceFeedback } from './feedback'
import { HouseholdProvider, useWorkspaceState } from './workspace'
import './household.css'

export interface HouseholdWorkspaceProps {
  backend: RemoteBackend
  onPendingChange?: (pending: boolean) => void
}

const backendScopes = new WeakMap<RemoteBackend, number>()
let nextBackendScope = 0

export default function HouseholdWorkspace(props: HouseholdWorkspaceProps) {
  const generation = useSyncExternalStore(
    props.backend.subscribe,
    () => props.backend.api.generation
  )
  let scope = backendScopes.get(props.backend)
  if (scope === undefined) {
    scope = ++nextBackendScope
    backendScopes.set(props.backend, scope)
  }
  if (!props.backend.api.authenticated)
    return (
      <section className="hh-workspace" aria-label="Household collection">
        <p role="status">
          Sign in to load your private household collection. Previous working state has been
          cleared.
        </p>
      </section>
    )
  return <PrivateWorkspace key={`${scope}:${generation}`} {...props} />
}

const workflows = [
  ['collection', 'Collection'],
  ['import', 'Import / save workbench'],
  ['trackers', 'Observed trackers'],
  ['trade', 'Household trade'],
  ['support', 'Capabilities / evidence'],
] as const
type Workflow = (typeof workflows)[number][0]

function PrivateWorkspace({ backend, onPendingChange }: HouseholdWorkspaceProps) {
  const state = useWorkspaceState(backend, onPendingChange)
  const {
    connection,
    data,
    loading,
    busy,
    intent,
    local,
    refresh,
    save,
    rollback,
    rebase,
    canRebase,
  } = state
  const [workflow, setWorkflow] = useState<Workflow>('collection')
  const [selected, setSelected] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [rebaseConsent, setRebaseConsent] = useState('')
  const record = data?.records.find((item) => item.id === selected)
  const rebaseVersion = `${data?.vault.revision ?? ''}:${connection.revision ?? ''}`
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    if (
      data &&
      selected &&
      connection.coherent &&
      !busy &&
      !intent &&
      !data.records.some((item) => item.id === selected)
    )
      setSelected('')
  }, [busy, connection.coherent, data, intent, selected])

  return (
    <HouseholdProvider value={state}>
      <main
        className="hh-workspace"
        aria-label="Household collection"
        aria-busy={loading || busy || intent?.sending}
      >
        <header className="hh-workspace-header">
          <div>
            <h1>Household vault</h1>
            <p>
              {data
                ? `${data.vault.pokemon_count} Pokémon · staged view revision ${data.vault.revision}`
                : 'Private collection'}
              {connection.revision !== undefined ? ` · server snapshot ${connection.revision}` : ''}
            </p>
          </div>
          <div className="hh-toolbar">
            <button disabled={busy || !!intent} onClick={() => void local(refresh)}>
              Refresh server
            </button>
            <button
              disabled={
                busy ||
                !!intent ||
                !connection.editing ||
                (connection.conflicted && !connection.uncertain)
              }
              onClick={() => void save()}
            >
              {connection.uncertain ? 'Retry exact save' : 'Save changes'}
            </button>
            <button
              disabled={busy || !!intent || !connection.editing || connection.uncertain}
              onClick={() => void rollback()}
            >
              Roll back staged changes
            </button>
          </div>
        </header>
        {!online && (
          <p className="hh-warning" role="status">
            Your browser reports offline. Keep this tab open: staged edits and exact uncertain
            requests are retained in this session. No offline mutation is fabricated as successful.
          </p>
        )}
        {connection.editing && (
          <p className="hh-editing" role="status">
            Unsaved changes.{' '}
            {connection.uncertain
              ? 'Save outcome uncertain: replay the same retained commit before changing or discarding edits.'
              : 'Nothing staged is durable until Save changes acknowledges it. Imports are independent acknowledged copies.'}
          </p>
        )}
        {connection.lastCommittedRevision !== undefined &&
          !connection.coherent &&
          !connection.editing && (
            <p className="hh-warning">
              Save was acknowledged at revision {connection.lastCommittedRevision}; its refresh is
              not yet coherent. Retry the read, not a new save.
            </p>
          )}
        <WorkspaceFeedback />
        {busy && (
          <p role="status">
            Working… controls are temporarily locked while the current read or staging action
            completes.
          </p>
        )}
        {connection.conflicted && (
          <section className="hh-card" aria-label="Explicit conflict recovery">
            <h2>Review and rebase</h2>
            <p>
              Refresh first. Three-way rebase preserves unrelated changes and refuses contested
              names, slots, metadata, or duplicate placements. It does not silently overwrite a
              newer vault. Record deletions require rollback/restaging.
            </p>
            <label className="hh-check">
              <input
                type="checkbox"
                checked={rebaseConsent === rebaseVersion}
                disabled={busy || !!intent || connection.uncertain}
                onChange={(event) => setRebaseConsent(event.target.checked ? rebaseVersion : '')}
              />
              I reviewed the staged and current revisions and want to deliberately rebase these
              edits.
            </label>
            <button
              disabled={
                busy ||
                !!intent ||
                connection.uncertain ||
                !canRebase ||
                rebaseConsent !== rebaseVersion
              }
              onClick={() => void rebase()}
            >
              Rebase reviewed edits
            </button>
          </section>
        )}
        <nav className="hh-workflow-nav" aria-label="Household workflows">
          {workflows.map(([value, name]) => (
            <button
              key={value}
              aria-pressed={workflow === value}
              onClick={() => setWorkflow(value)}
            >
              {name}
            </button>
          ))}
        </nav>
        {loading && <p role="status">Loading revision-pinned vault and real Pokémon records…</p>}
        {!loading && !data && (
          <p role="status">
            Collection unavailable. The error above is not an empty vault; use Refresh server to
            retry.
          </p>
        )}
        <section hidden={workflow !== 'collection'} aria-label="Collection workflow">
          {data && (
            <div className="hh-collection-layout">
              <div>
                <VaultPanel selected={selected} onSelect={setSelected} />
                <SearchPanel selected={selected} onSelect={setSelected} />
              </div>
              {record ? (
                <RecordPanel key={record.id} record={record} />
              ) : (
                <aside className="hh-card">
                  <h2>Pokémon details</h2>
                  <p>
                    Select an occupied slot, an unplaced record, or a search result to inspect real
                    canonical bytes, personal metadata, and export choices.
                  </p>
                </aside>
              )}
            </div>
          )}
        </section>
        <section hidden={workflow !== 'import'} aria-label="Import workflow">
          <ImportPanel
            selected={record}
            onAcquired={(id) => {
              setSelected(id)
              setWorkflow('collection')
            }}
          />
        </section>
        <section hidden={workflow !== 'trackers'} aria-label="Tracker workflow">
          <TrackerPanel active={workflow === 'trackers'} />
        </section>
        <section hidden={workflow !== 'trade'} aria-label="Trade workflow">
          <TradePanel />
        </section>
        <section hidden={workflow !== 'support'} aria-label="Support workflow">
          <SupportPanel />
        </section>
      </main>
    </HouseholdProvider>
  )
}
