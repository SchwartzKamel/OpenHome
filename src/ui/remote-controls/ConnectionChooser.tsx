import { isDesktopShell } from '@openhome-core/remote/local'
import { Button, Flex } from '@radix-ui/themes'
import { useEffect, useState } from 'react'
import {
  makeProfile,
  PROFILE_STORAGE_KEY,
  readProfiles,
  saveProfile,
  type ServerProfile,
} from './profiles'

export default function ConnectionChooser({
  busy,
  onConnect,
  onLocal,
}: {
  busy: boolean
  onConnect: (profile: ServerProfile) => void
  onLocal: () => void
}) {
  const [profiles, setProfiles] = useState<ServerProfile[]>([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [save, setSave] = useState(true)
  const [error, setError] = useState<string>()
  useEffect(() => {
    try {
      setProfiles(readProfiles(window.localStorage))
    } catch {
      setError('Saved profiles could not be read. You can connect without saving a profile.')
    }
  }, [])
  return (
    <section className="remote-panel remote-chooser" aria-label="Choose connection">
      <h2>Choose your connection</h2>
      <Flex gap="2" align="center" wrap="wrap">
        <Button type="button" variant="soft" disabled={busy || !isDesktopShell()} onClick={onLocal}>
          Local desktop
        </Button>
        {!isDesktopShell() && (
          <p>Local filesystem mode is available only in the actual Tauri app.</p>
        )}
      </Flex>
      {profiles.length > 0 && (
        <ul className="remote-list" aria-label="Saved servers">
          {profiles.map((profile) => (
            <li key={profile.origin}>
              <Button
                type="button"
                variant="soft"
                disabled={busy}
                onClick={() => onConnect(profile)}
              >
                Connect {profile.name}
              </Button>
              <span>{profile.origin}</span>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  try {
                    const next = profiles.filter((item) => item.origin !== profile.origin)
                    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(next))
                    setProfiles(next)
                  } catch {
                    setError('The profile could not be removed from browser storage.')
                  }
                }}
              >
                Remove {profile.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="remote-form"
        onSubmit={(event) => {
          event.preventDefault()
          try {
            const profile = makeProfile(name, address)
            setError(undefined)
            if (save) {
              try {
                setProfiles(saveProfile(window.localStorage, profiles, profile))
              } catch {
                setError(
                  'The profile could not be saved. Uncheck “Save name and origin” to connect without saving.'
                )
                return
              }
            }
            onConnect(profile)
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Enter a valid server origin.')
          }
        }}
      >
        <label htmlFor="server-profile-name">Server profile name</label>
        <input
          id="server-profile-name"
          value={name}
          required
          maxLength={64}
          disabled={busy}
          autoComplete="off"
          placeholder="Home server"
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="server-origin">Server origin</label>
        <input
          id="server-origin"
          type="url"
          value={address}
          required
          disabled={busy}
          autoComplete="url"
          placeholder="https://vault.example.net"
          onChange={(event) => setAddress(event.target.value)}
        />
        <label className="remote-check">
          <input
            type="checkbox"
            checked={save}
            disabled={busy}
            onChange={(event) => setSave(event.target.checked)}
          />
          Save name and origin only on this device. Never save credentials.
        </label>
        <Button type="submit" disabled={busy}>
          Connect to server
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
