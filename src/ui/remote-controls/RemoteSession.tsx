import { BackendContext } from '@openhome-core/backend'
import { type RemoteBackend, type RemoteError, type SessionGrant } from '@openhome-core/remote'
import { Badge, Callout } from '@radix-ui/themes'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import AuthForm from './AuthForm'
import { FailureNotice } from './common'
import { useConnection } from './safety'

const HouseholdWorkspace = lazy(() => import('@openhome-ui/household/HouseholdWorkspace'))
const HumanTools = lazy(() => import('./HumanTools'))

export default function RemoteSession({
  backend,
  onPendingChange,
}: {
  backend: RemoteBackend
  onPendingChange: (pending: boolean) => void
}) {
  const { connection, generation } = useConnection(backend)
  const [identity, setIdentity] = useState<{ generation: number; grant: SessionGrant }>()
  const [syncError, setSyncError] = useState<RemoteError>()
  const [sessionEnded, setSessionEnded] = useState(false)
  const wasAuthenticated = useRef(backend.api.authenticated)
  const currentIdentity = identity?.generation === generation ? identity.grant : undefined
  useEffect(() => {
    setIdentity((previous) => (previous?.generation === generation ? previous : undefined))
    if (wasAuthenticated.current && !backend.api.authenticated) setSessionEnded(true)
    wasAuthenticated.current = backend.api.authenticated
  }, [backend, generation])
  useEffect(() => {
    let active = true
    if (backend.api.authenticated) {
      void backend.connect().then((result) => {
        if (active && result.status === 'error') setSyncError(result.failure)
      })
    }
    return () => {
      active = false
      backend.stopEvents()
    }
  }, [backend, generation])
  return (
    <BackendContext value={backend}>
      <div className="remote-session">
        <div className="remote-connection-status">
          <span>{backend.api.baseUrl}</span>
          <Badge color={connection.coherent ? 'teal' : 'amber'}>
            {connection.authenticated
              ? connection.coherent
                ? `Synchronized · revision ${connection.revision}`
                : 'Synchronizing / not coherent'
              : 'Signed out'}
          </Badge>
          {connection.editing && <Badge color="amber">Unsaved collection edits</Badge>}
          {connection.uncertain && <Badge color="red">Commit outcome uncertain</Badge>}
        </div>
        {connection.transportSecurity !== 'https' && connection.authenticated && (
          <Callout.Root color="amber">
            <Callout.Text>
              Insecure HTTP LAN connection: traffic is not encrypted. Your explicit acknowledgement
              applies to this connection only.
            </Callout.Text>
          </Callout.Root>
        )}
        {connection.authenticated ? (
          <div key={generation}>
            <FailureNotice failure={connection.lastError ?? syncError} />
            {currentIdentity ? (
              <>
                <p>
                  Signed in as <strong>{currentIdentity.user.username}</strong> ·{' '}
                  {currentIdentity.user.role}. Session expires{' '}
                  {new Date(currentIdentity.expires_at).toLocaleString()}.
                </p>
                <Suspense fallback={<p role="status">Loading authenticated account tools…</p>}>
                  <HumanTools backend={backend} user={currentIdentity.user} />
                </Suspense>
              </>
            ) : (
              <p>
                Authenticated connection supplied by the host. Sign out and sign in here to enable
                verified human account, pairing and backup controls; the client will not guess your
                identity or admin role.
              </p>
            )}
            <Suspense fallback={<p role="status">Loading household workspace…</p>}>
              <HouseholdWorkspace backend={backend} onPendingChange={onPendingChange} />
            </Suspense>
          </div>
        ) : (
          <>
            {sessionEnded && (
              <p role="alert">Your session ended. Private data was cleared. Sign in again.</p>
            )}
            <AuthForm
              backend={backend}
              onAuthenticated={(grant) => {
                setSyncError(undefined)
                setSessionEnded(false)
                setIdentity({ generation: backend.api.generation, grant })
              }}
            />
          </>
        )}
      </div>
    </BackendContext>
  )
}
