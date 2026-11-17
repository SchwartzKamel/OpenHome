import type BackendInterface from '@openhome-core/backend/backendInterface'
import { useEffect, useState } from 'react'
import { RemoteBackend } from './backend'
import { isDesktopShell, loadLocalBackend } from './local'
import type * as Wire from './wire-types'

export function useStartupBackend(provided?: BackendInterface) {
  const [local, setLocal] = useState<BackendInterface>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (provided || !isDesktopShell()) return
    let active = true
    loadLocalBackend().then(
      (backend) => {
        if (active) setLocal(backend)
      },
      (failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Local backend failed to load')
      }
    )
    return () => {
      active = false
    }
  }, [provided])
  return { backend: provided ?? local, error }
}

export function Disconnected({ error }: { error?: string }) {
  const [later, setLater] = useState(false)
  return (
    <main style={{ padding: 32 }}>
      <h1>OpenHome</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <p role="status">
          {later
            ? 'You can connect to a household server later.'
            : 'No household server connected.'}
        </p>
      )}
      {!later && (
        <button type="button" onClick={() => setLater(true)}>
          Connect later
        </button>
      )}
      <p>
        Local mode requires the desktop app. Server connection controls are a separate client
        feature.
      </p>
    </main>
  )
}

// The backend slice deliberately provides only authenticated browsing. Login,
// pairing, backup and full capability-aware editing controls belong to the next UI slice.
export function RemoteVault({ backend }: { backend: RemoteBackend }) {
  const [connection, setConnection] = useState(backend.connection)
  const [data, setData] = useState<{ vault: Wire.VaultState; records: Wire.PokemonRecord[] }>()
  useEffect(() => {
    let active = true
    const update = () => {
      if (!active) return
      const current = backend.connection
      setConnection(current)
      if (!current.authenticated || !current.coherent) {
        setData(undefined)
        return
      }
      const generation = backend.api.generation
      void Promise.all([backend.getVault(), backend.getRecords()]).then(([vault, records]) => {
        if (!active || generation !== backend.api.generation || !backend.connection.coherent) return
        if (vault.status === 'ok' && records.status === 'ok')
          setData({ vault: vault.data, records: records.data })
      })
    }
    const unsubscribe = backend.subscribe(update)
    if (backend.api.authenticated) void backend.connect()
    update()
    return () => {
      active = false
      unsubscribe()
      backend.stopEvents()
    }
  }, [backend])

  if (!connection.authenticated) return <Disconnected error={connection.lastError?.message} />
  const records = new Map(data?.records.map((record) => [record.id, record]))
  return (
    <main style={{ padding: 24 }}>
      <h1>OpenHome household vault</h1>
      {connection.transportSecurity !== 'https' && (
        <p role="alert">Insecure HTTP LAN connection: traffic is not encrypted.</p>
      )}
      {connection.lastError && (
        <p role="alert">
          {connection.lastError.code}: {connection.lastError.message}
        </p>
      )}
      {connection.conflicted && (
        <p role="alert">
          The server changed. Local edits were retained and require an explicit rebase or rollback.
        </p>
      )}
      {!data && <p role="status">Synchronizing household vault…</p>}
      {data && (
        <>
          <p>
            Revision {data.vault.revision} · {data.vault.pokemon_count} Pokémon · observed
            collection, not official HOME completion
          </p>
          {data.vault.content.banks.map((bank) => (
            <section key={bank.id} aria-label={bank.name}>
              <h2>{bank.name}</h2>
              {bank.boxes.map((box) => (
                <section key={box.id} aria-label={box.name}>
                  <h3>{box.name}</h3>
                  <ol>
                    {box.slots.map((id, slot) => {
                      const record = id ? records.get(id) : undefined
                      return (
                        <li key={slot}>
                          {record
                            ? record.observed.nickname || `Species ${record.observed.species}`
                            : 'Empty'}
                        </li>
                      )
                    })}
                  </ol>
                </section>
              ))}
            </section>
          ))}
        </>
      )}
    </main>
  )
}
