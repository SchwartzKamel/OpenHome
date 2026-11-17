import type BackendInterface from '@openhome-core/backend/backendInterface'
import RemoteEntry from '@openhome-core/remote/entry'
import useIsDarkMode from '@openhome-ui/hooks/darkMode'
import { Theme } from '@radix-ui/themes'
import { lazy, Suspense } from 'react'
import './App.css'

const LocalWorkspace = lazy(() => import('@openhome-ui/remote-controls/LocalWorkspace'))

export default function App({ backend }: { backend?: BackendInterface } = {}) {
  const isDarkMode = useIsDarkMode()
  return (
    <Theme
      accentColor="red"
      grayColor="gray"
      appearance={isDarkMode ? 'dark' : 'light'}
      style={{ background: 'var(--background-gradient)' }}
      radius="small"
    >
      <div id="app-container" className="root">
        <RemoteEntry
          backend={backend}
          renderLocal={(local) => (
            <Suspense fallback={<p role="status">Loading local OpenHome workspace…</p>}>
              <LocalWorkspace backend={local} />
            </Suspense>
          )}
        />
      </div>
    </Theme>
  )
}
