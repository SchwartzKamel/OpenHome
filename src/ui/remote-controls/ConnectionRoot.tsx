import type BackendInterface from '@openhome-core/backend/backendInterface'
import { ConfirmAction } from '@openhome-ui/remote-controls/common'
import type { ServerProfile } from './profiles'
import ConnectionChooser from './ConnectionChooser'
import { SafetyProvider } from '@openhome-ui/remote-controls/safety'
import { Badge, Button, Flex } from '@radix-ui/themes'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { RemoteBackend } from '@openhome-core/remote/backend'
import { isDesktopShell, loadLocalBackend } from '@openhome-core/remote/local'

const RemoteSession = lazy(() => import('@openhome-ui/remote-controls/RemoteSession'))
let connectionSequence = 0

type Mode =
  | { kind: 'disconnected' }
  | { kind: 'local'; backend: BackendInterface }
  | { kind: 'remote'; backend: RemoteBackend; profile: ServerProfile; connectionId: number }
type Destination = { kind: 'remote'; profile: ServerProfile } | { kind: 'local' }

function suppliedMode(backend?: BackendInterface): Mode {
  if (backend instanceof RemoteBackend)
    return {
      kind: 'remote',
      backend,
      profile: { name: 'Household server', origin: backend.api.baseUrl },
      connectionId: ++connectionSequence,
    }
  return backend ? { kind: 'local', backend } : { kind: 'disconnected' }
}

export default function ConnectionRoot({
  backend: providedBackend,
  renderLocal,
  initialProfile,
}: {
  backend?: BackendInterface
  renderLocal: (backend: BackendInterface) => ReactNode
  initialProfile?: ServerProfile
}) {
  const [mode, setMode] = useState<Mode>(() =>
    initialProfile
      ? {
          kind: 'remote',
          backend: new RemoteBackend({ baseUrl: initialProfile.origin }),
          profile: initialProfile,
          connectionId: ++connectionSequence,
        }
      : suppliedMode(providedBackend)
  )
  const [chooser, setChooser] = useState(!providedBackend && !initialProfile)
  const [later, setLater] = useState(false)
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [revocation, setRevocation] = useState<string>()
  const [confirm, setConfirm] = useState<{ destination?: Destination; logout: boolean }>()
  const [blocked, setBlocked] = useState(false)
  const blockers = useRef(new Set<string>())
  const localBackend = useRef<BackendInterface>(undefined)
  const interaction = useRef(false)
  const previousProvided = useRef(providedBackend)
  const [, updateConnection] = useState(0)
  const report = useCallback((key: string, value: boolean) => {
    if (value) blockers.current.add(key)
    else blockers.current.delete(key)
    setBlocked(blockers.current.size > 0)
  }, [])
  const reportHousehold = useCallback((pending: boolean) => report('household', pending), [report])

  useEffect(() => {
    if (providedBackend !== previousProvided.current) {
      previousProvided.current = providedBackend
      setMode(suppliedMode(providedBackend))
      setChooser(!providedBackend)
    }
  }, [providedBackend])

  useEffect(() => {
    if (providedBackend || !isDesktopShell()) return
    let active = true
    void loadLocalBackend().then(
      (backend) => {
        localBackend.current = backend
        if (active && !interaction.current) {
          setMode({ kind: 'local', backend })
          setChooser(false)
        }
      },
      () => {
        if (active) setProblem('The local desktop backend could not be loaded.')
      }
    )
    return () => {
      active = false
    }
  }, [providedBackend])

  useEffect(() => {
    if (mode.kind !== 'remote') return
    return mode.backend.subscribe(() => updateConnection((value) => value + 1))
  }, [mode])

  const hasEdits = mode.kind === 'remote' && mode.backend.connection.editing
  const uncertain = mode.kind === 'remote' && mode.backend.connection.uncertain
  useEffect(() => {
    if (!blocked && !hasEdits && !uncertain) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [blocked, hasEdits, uncertain])

  const activate = async (destination: Destination) => {
    interaction.current = true
    setProblem(undefined)
    setBusy(true)
    try {
      let next: Mode
      if (destination.kind === 'local') {
        if (!isDesktopShell()) throw new Error('Local mode requires the actual Tauri desktop app.')
        const backend = localBackend.current ?? (await loadLocalBackend())
        localBackend.current = backend
        next = { kind: 'local', backend }
      } else {
        next = {
          kind: 'remote',
          profile: destination.profile,
          backend: new RemoteBackend({ baseUrl: destination.profile.origin }),
          connectionId: ++connectionSequence,
        }
      }
      if (mode.kind === 'remote') mode.backend.dispose()
      blockers.current.clear()
      setBlocked(false)
      setMode(next)
      setChooser(false)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The connection could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  const requestSwitch = async (destination: Destination) => {
    interaction.current = true
    setProblem(undefined)
    if (busy) return
    if (mode.kind === 'local' && destination.kind === 'local') {
      setChooser(false)
      return
    }
    if (blocked || (mode.kind === 'remote' && mode.backend.connection.uncertain)) {
      setProblem(
        'Connection not switched. Finish or explicitly dismiss pending forms and retry any retained uncertain request first. Its key and bytes must not be lost.'
      )
      return
    }
    if (mode.kind === 'local') {
      try {
        const state = await mode.backend.getState()
        if (state.status === 'error' || state.data.transaction.open_transaction) {
          setProblem('Finish the local save transaction before switching connections.')
          return
        }
      } catch {
        setProblem('Local save state could not be checked. The current mode was retained.')
        return
      }
      setConfirm({ destination, logout: false })
    } else if (
      mode.kind === 'remote' &&
      (mode.backend.api.authenticated || mode.backend.connection.editing)
    ) {
      setConfirm({ destination, logout: false })
    } else {
      await activate(destination)
    }
  }

  const clearAndLeave = async (destination?: Destination) => {
    setConfirm(undefined)
    if (
      destination &&
      (blockers.current.size > 0 || (mode.kind === 'remote' && mode.backend.connection.uncertain))
    ) {
      setProblem('Connection not switched. A pending or uncertain request must be resolved first.')
      return
    }
    setBusy(true)
    setProblem(undefined)
    setRevocation(undefined)
    if (mode.kind === 'local' && destination) {
      try {
        const state = await mode.backend.getState()
        if (state.status === 'error' || state.data.transaction.open_transaction) {
          setBusy(false)
          setProblem('The local save state changed. Finish its transaction before switching.')
          return
        }
      } catch {
        setBusy(false)
        setProblem('The local save state could not be rechecked; the workspace was retained.')
        return
      }
    }
    if (mode.kind === 'remote') {
      const backend = mode.backend
      if (destination && backend.connection.editing && !backend.connection.uncertain) {
        const result = await backend.rollbackTransaction()
        if (result.status === 'error') {
          setBusy(false)
          setProblem('Local edits could not be safely discarded. The connection was retained.')
          return
        }
      }
      if (destination && (blockers.current.size > 0 || backend.connection.uncertain)) {
        setBusy(false)
        setProblem('Connection not switched. New pending work appeared while checking local edits.')
        return
      }
      try {
        setClearing(true)
        await backend.api.logout()
        setRevocation(
          'Signed out. The server confirmed session revocation and private data was cleared.'
        )
      } catch {
        setRevocation(
          'Local session and private data cleared. Server revocation is unconfirmed because the logout request failed. Sign in again to check access; an unexpired session may still exist on the server.'
        )
      } finally {
        backend.stopEvents()
        blockers.current.clear()
        setBlocked(false)
        setClearing(false)
      }
      if (backend.api.authenticated) {
        setBusy(false)
        setProblem(
          'A newer authenticated identity replaced the session during sign-out. It was retained; review the current connection before switching.'
        )
        return
      }
    }
    setBusy(false)
    if (destination) await activate(destination)
  }

  return (
    <SafetyProvider report={report}>
      <div className={mode.kind === 'local' ? 'remote-local-shell' : 'remote-shell'}>
        {mode.kind === 'local' ? (
          <>
            <Button
              className="remote-local-switch"
              type="button"
              variant="solid"
              onClick={() => setChooser(true)}
            >
              Connection: Local
            </Button>
            {renderLocal(mode.backend)}
            {chooser && (
              <aside
                className="remote-shell remote-local-overlay"
                aria-label="Choose desktop connection"
              >
                <Flex gap="3" align="center" justify="between" wrap="wrap">
                  <h1>OpenHome connection</h1>
                  <Button type="button" variant="soft" onClick={() => setChooser(false)}>
                    Return to local workspace
                  </Button>
                </Flex>
                {problem && <p role="alert">{problem}</p>}
                <ConnectionChooser
                  busy={busy}
                  onConnect={(profile) => void requestSwitch({ kind: 'remote', profile })}
                  onLocal={() => setChooser(false)}
                />
              </aside>
            )}
          </>
        ) : (
          <>
            <header className="remote-header">
              <div>
                <h1>OpenHome</h1>
                <p>
                  {mode.kind === 'remote' ? mode.profile.name : 'Your collection, your household'}
                </p>
              </div>
              <Flex gap="2" align="center" wrap="wrap">
                <Badge color={mode.kind === 'remote' ? 'teal' : 'gray'}>
                  {mode.kind === 'remote' ? 'Remote server' : 'Not connected'}
                </Badge>
                {mode.kind !== 'disconnected' && (
                  <Button
                    type="button"
                    variant="soft"
                    disabled={busy}
                    onClick={() => setChooser(!chooser)}
                  >
                    {chooser ? 'Back to current connection' : 'Switch connection'}
                  </Button>
                )}
                {mode.kind === 'remote' && (mode.backend.api.authenticated || blocked) && (
                  <Button
                    type="button"
                    variant="soft"
                    color="red"
                    disabled={busy}
                    onClick={() => setConfirm({ logout: true })}
                  >
                    {mode.backend.api.authenticated ? 'Sign out' : 'Clear pending sign-in'}
                  </Button>
                )}
              </Flex>
            </header>
            {problem && (
              <p role="alert" className="remote-notice">
                {problem}
              </p>
            )}
            {revocation && (
              <p role="status" className="remote-notice">
                {revocation}
              </p>
            )}
            {busy && <p role="status">Closing the previous session…</p>}
            {chooser && (
              <ConnectionChooser
                busy={busy}
                onConnect={(profile) => void requestSwitch({ kind: 'remote', profile })}
                onLocal={() => void requestSwitch({ kind: 'local' })}
              />
            )}
            {mode.kind === 'disconnected' && (
              <section className="remote-welcome">
                <p role="status">
                  {later
                    ? 'You can connect to a household server later.'
                    : 'No household server connected.'}
                </p>
                {!later && (
                  <Button type="button" variant="soft" onClick={() => setLater(true)}>
                    Connect later
                  </Button>
                )}
                <p>
                  Local mode requires the desktop app. Browser mode never accesses server files or
                  host paths.
                </p>
              </section>
            )}
            {mode.kind === 'remote' && !clearing && (
              <fieldset disabled={busy} className="remote-session-fieldset">
                <legend className="remote-visually-hidden">Current server connection</legend>
                <Suspense fallback={<p role="status">Loading household controls…</p>}>
                  <RemoteSession
                    key={mode.connectionId}
                    backend={mode.backend}
                    onPendingChange={reportHousehold}
                  />
                </Suspense>
              </fieldset>
            )}
          </>
        )}
        {confirm && (
          <ConfirmAction
            key={confirm.logout ? 'logout' : 'switch'}
            title={confirm.logout ? 'Sign out and clear private data?' : 'Switch connection?'}
            action={confirm.logout ? 'Sign out and clear' : 'Discard edits and switch'}
            onCancel={() => setConfirm(undefined)}
            onConfirm={() => void clearAndLeave(confirm.destination)}
          >
            {mode.kind === 'local'
              ? 'Save local game files and collection changes before leaving. Switching does not save them and unmounts the local workspace.'
              : 'Local edits, selected files and private UI caches will be cleared. An accepted or uncertain operation may still commit. Signing out cannot undo an import or a server-acknowledged operation.'}
            {(blocked || uncertain) && (
              <p>
                A request or edit is still pending or uncertain. Prefer Retry same request first.
                Explicit sign-out forgets that tab-local receipt and does not prove whether the
                server committed it.
              </p>
            )}
          </ConfirmAction>
        )}
      </div>
    </SafetyProvider>
  )
}
