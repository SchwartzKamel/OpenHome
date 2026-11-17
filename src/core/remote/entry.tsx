import type BackendInterface from '@openhome-core/backend/backendInterface'
import ConnectionChooser from '@openhome-ui/remote-controls/ConnectionChooser'
import type { ServerProfile } from '@openhome-ui/remote-controls/profiles'
import { Button } from '@radix-ui/themes'
import { lazy, type ReactNode, Suspense, useState } from 'react'
import { isDesktopShell } from './local'
import '@openhome-ui/remote-controls/remote-controls.css'

const ConnectionRoot = lazy(() => import('@openhome-ui/remote-controls/ConnectionRoot'))

export default function RemoteEntry({
  backend,
  renderLocal,
}: {
  backend?: BackendInterface
  renderLocal: (backend: BackendInterface) => ReactNode
}) {
  const [profile, setProfile] = useState<ServerProfile>()
  const [later, setLater] = useState(false)
  const [local, setLocal] = useState(false)
  if (backend || profile || local || isDesktopShell()) {
    return (
      <Suspense
        fallback={
          <main className="remote-shell">
            <h1>OpenHome</h1>
            <p role="status">Loading connection controls…</p>
          </main>
        }
      >
        <ConnectionRoot backend={backend} initialProfile={profile} renderLocal={renderLocal} />
      </Suspense>
    )
  }
  return (
    <main className="remote-shell">
      <header className="remote-header">
        <div>
          <h1>OpenHome</h1>
          <p>Your collection, your household</p>
        </div>
      </header>
      <ConnectionChooser busy={false} onConnect={setProfile} onLocal={() => setLocal(true)} />
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
          Local mode requires the desktop app. Browser mode never accesses server files or host
          paths.
        </p>
      </section>
    </main>
  )
}
