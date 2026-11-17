import {
  type Device,
  type DevicePage,
  type PairingCode,
  parseWire,
  type RemoteBackend,
  type User,
} from '@openhome-core/remote'
import { Button, Flex } from '@radix-ui/themes'
import { useId, useRef, useState } from 'react'
import { ActionFeedback, ConfirmAction, FailureNotice, useSecondsUntil } from './common'
import { usePreparedAction, usePrivateRead, useSafety } from './safety'

export default function AccountControls({ backend, user }: { backend: RemoteBackend; user: User }) {
  const [code, setCode] = useState<PairingCode>()
  const [copyNotice, setCopyNotice] = useState<string>()
  const codeInput = useRef<HTMLInputElement>(null)
  const pairing = usePreparedAction<PairingCode>(backend, ({ data }) => {
    setCode(data)
    setCopyNotice(undefined)
    void backend.resync()
  })
  const expiresIn = useSecondsUntil(code ? Date.parse(code.expires_at) : 0)
  const devices = usePrivateRead<DevicePage>(backend)
  const [revoking, setRevoking] = useState<Device>()
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(() => new Set())
  const revoke = usePreparedAction<null>(backend, () => {
    const id = revoking?.id
    if (id) setRevoked((previous) => new Set([...previous, id]))
    setRevoking(undefined)
    void backend.resync()
    void devices.run(
      async () => (await backend.api.call('listDevices', { query: { limit: 100 } })).data
    )
  })

  const loadDevices = (more = false) => {
    const previous = devices.data
    void devices.run(async () => {
      const { data } = await backend.api.call('listDevices', {
        query: {
          limit: 100,
          ...(more && previous?.next_cursor && { cursor: previous.next_cursor }),
        },
      })
      return more && previous ? { ...data, items: [...previous.items, ...data.items] } : data
    })
  }

  return (
    <details className="remote-panel">
      <summary>Account &amp; 3DS pairing</summary>
      <section aria-label="Pair a 3DS">
        <h2>Pair a 3DS</h2>
        <p>
          Generate a one-use six-digit code for <strong>{user.username}</strong>. On the console,
          enter this server origin, username and code. Its revocable bearer is generated on the
          console, never put in a URL.
        </p>
        <Button
          type="button"
          disabled={pairing.busy || pairing.retained}
          onClick={() =>
            void pairing.start(() => {
              const request = backend.api.prepare('createPairingCode', { body: {} })
              setCode(undefined)
              setCopyNotice(undefined)
              return request
            })
          }
        >
          {code ? 'Generate replacement pairing code' : 'Generate pairing code'}
        </Button>
        {code && (
          <div className="remote-pairing">
            <label>
              One-use pairing code
              <input
                ref={codeInput}
                value={code.code}
                readOnly
                inputMode="numeric"
                autoComplete="off"
                className="remote-code"
                onFocus={(event) => event.target.select()}
              />
            </label>
            <p>
              {expiresIn > 0 ? `Expires in ${expiresIn}s` : 'Expired — generate a new code'} ·{' '}
              <time dateTime={code.expires_at}>{new Date(code.expires_at).toLocaleString()}</time>
              {' · '}
              {code.attempts_remaining} attempts remaining when issued.
            </p>
            <Button
              type="button"
              variant="soft"
              disabled={expiresIn === 0}
              onClick={() => {
                const fallback = () => {
                  codeInput.current?.focus()
                  codeInput.current?.select()
                  setCopyNotice(
                    'Clipboard unavailable here. The code is selected; copy it manually.'
                  )
                }
                if (!navigator.clipboard?.writeText) {
                  fallback()
                  return
                }
                void navigator.clipboard
                  .writeText(code.code)
                  .then(() => setCopyNotice('Pairing code copied.'), fallback)
              }}
            >
              Copy pairing code
            </Button>
            {copyNotice && <p role="status">{copyNotice}</p>}
            <p>Generating a replacement invalidates the previous code. Codes are never saved.</p>
          </div>
        )}
        <ActionFeedback action={pairing} />
        <p>
          Physical cartridge, digital and VC writes are disabled in this client pending a verified
          backup and independent hardware release gate. Pairing is not native-write certification.
        </p>
      </section>
      <section aria-label="Paired devices">
        <h2>Paired devices</h2>
        <Button
          type="button"
          variant="soft"
          disabled={devices.busy || revoke.busy || revoke.retained}
          onClick={() => loadDevices()}
        >
          {devices.data ? 'Refresh devices' : 'Load devices'}
        </Button>
        {devices.busy && <p role="status">Loading devices…</p>}
        <FailureNotice failure={devices.failure} />
        {!devices.data && !devices.busy && <p>Devices have not been loaded.</p>}
        {devices.data && (
          <>
            {devices.data.items.length === 0 && <p>No paired devices.</p>}
            <ul className="remote-list">
              {devices.data.items.map((device) => (
                <li key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <p>
                      Expires {new Date(device.expires_at).toLocaleString()}
                      {device.revoked_at || revoked.has(device.id) ? ' · Revoked' : ' · Active'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    color="red"
                    variant="soft"
                    disabled={
                      Boolean(device.revoked_at) ||
                      revoked.has(device.id) ||
                      revoke.busy ||
                      revoke.retained
                    }
                    onClick={() => setRevoking(device)}
                  >
                    Revoke {device.name}
                  </Button>
                </li>
              ))}
            </ul>
            {devices.data.next_cursor && (
              <Button type="button" disabled={devices.busy} onClick={() => loadDevices(true)}>
                Load more devices
              </Button>
            )}
          </>
        )}
        {revoked.size > 0 && <p role="status">The server confirmed immediate device revocation.</p>}
        <ActionFeedback action={revoke} />
        {revoking && !revoke.retained && (
          <ConfirmAction
            title={`Revoke ${revoking.name}?`}
            action="Revoke device now"
            busy={revoke.busy}
            onCancel={() => setRevoking(undefined)}
            onConfirm={() => {
              const deviceId = revoking.id
              void revoke.start(() =>
                backend.api.prepare('revokeDevice', { path: { device_id: deviceId } })
              )
            }}
          >
            This immediately prevents this device from accessing your collection. Its server
            connections are closed. Pair it again to restore access.
          </ConfirmAction>
        )}
      </section>
      {user.role === 'admin' ? (
        <CreateUser backend={backend} />
      ) : (
        <p>Only a human admin can create household accounts. There is no public signup.</p>
      )}
    </details>
  )
}

function CreateUser({ backend }: { backend: RemoteBackend }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [created, setCreated] = useState<User>()
  const [validation, setValidation] = useState<string>()
  const id = useId()
  const action = usePreparedAction<User>(backend, ({ data }) => {
    setCreated(data)
    setUsername('')
    setRole('member')
    void backend.resync()
  })
  const locked = action.busy || action.retained
  useSafety(password.length > 0 || username.length > 0)
  return (
    <section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Create household account</h2>
      <p>Each account has a private vault. Creation does not sign in as the new member.</p>
      <form
        className="remote-form"
        aria-busy={action.busy}
        onSubmit={(event) => {
          event.preventDefault()
          if (locked) return
          try {
            const body = parseWire('CreateUserRequest', { username, password, role })
            setValidation(undefined)
            void action.start(() => {
              const prepared = backend.api.prepare('createUser', { body })
              setPassword('')
              return prepared
            })
          } catch {
            setValidation('Use a valid lowercase username and a password of 12–128 characters.')
          }
        }}
      >
        <label htmlFor={`${id}-username`}>New member username</label>
        <input
          id={`${id}-username`}
          autoComplete="off"
          value={username}
          required
          minLength={3}
          maxLength={32}
          disabled={locked}
          onChange={(event) => setUsername(event.target.value)}
        />
        <label htmlFor={`${id}-password`}>New member password</label>
        <input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          required={!locked}
          minLength={12}
          maxLength={128}
          disabled={locked}
          onChange={(event) => setPassword(event.target.value)}
        />
        <label htmlFor={`${id}-role`}>Account role</label>
        <select
          id={`${id}-role`}
          value={role}
          disabled={locked}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'admin' || value === 'member') setRole(value)
          }}
        >
          <option value="member">Member (default)</option>
          <option value="admin">Admin — may create accounts</option>
        </select>
        <Flex gap="2">
          <Button type="submit" disabled={locked}>
            Create account
          </Button>
        </Flex>
      </form>
      {validation && <p role="alert">{validation}</p>}
      {created && (
        <p role="status">
          Created {created.username} as {created.role}.
        </p>
      )}
      <ActionFeedback action={action} />
    </section>
  )
}
