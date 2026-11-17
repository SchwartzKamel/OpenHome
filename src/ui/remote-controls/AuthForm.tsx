import { parseWire, type RemoteBackend, type SessionGrant } from '@openhome-core/remote'
import { Button, Callout } from '@radix-ui/themes'
import { useId, useState } from 'react'
import { ActionFeedback } from './common'
import { usePreparedAction, useSafety } from './safety'

export default function AuthForm({
  backend,
  onAuthenticated,
}: {
  backend: RemoteBackend
  onAuthenticated: (grant: SessionGrant) => void
}) {
  const [bootstrap, setBootstrap] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [acknowledged, setAcknowledged] = useState(backend.api.transportSecurity === 'https')
  const [validation, setValidation] = useState<string>()
  const id = useId()
  const action = usePreparedAction<SessionGrant>(backend, ({ data }) => onAuthenticated(data), true)
  const locked = action.busy || action.retained
  useSafety(password.length > 0 || setupToken.length > 0)
  const insecure = backend.api.transportSecurity !== 'https'

  return (
    <section className="remote-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        {bootstrap ? 'Set up the first owner' : 'Sign in to your household'}
      </h2>
      {insecure && (
        <Callout.Root color="amber">
          <Callout.Text>
            Insecure HTTP LAN connection. Passwords, setup secrets, pairing codes and collection
            data travel without encryption. Prefer HTTPS, especially outside a trusted home LAN.
          </Callout.Text>
        </Callout.Root>
      )}
      {insecure && !acknowledged && (
        <label className="remote-check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => {
              if (!event.target.checked) return
              backend.api.acknowledgeInsecureHttp()
              setAcknowledged(true)
            }}
          />
          I understand HTTP is unencrypted and explicitly allow sending credentials to this server.
        </label>
      )}
      <form
        className="remote-form"
        aria-busy={action.busy}
        onSubmit={(event) => {
          event.preventDefault()
          if (locked || !acknowledged) return
          try {
            parseWire('Username', username)
            parseWire('Password', password)
            if (bootstrap && !setupToken.trim()) {
              setValidation('Enter the one-time setup secret from server/data/setup-token.')
              return
            }
            setValidation(undefined)
            void action.start(() => {
              const prepared = bootstrap
                ? backend.api.beginBootstrap(username, password, setupToken)
                : backend.api.beginLogin(username, password)
              setPassword('')
              setSetupToken('')
              return prepared
            })
          } catch {
            setValidation(
              'Use a 3–32 character lowercase username (letters, digits, _ or -) and a 12–128 character password. A platform CSPRNG is required.'
            )
          }
        }}
      >
        <label htmlFor={`${id}-username`}>Username</label>
        <input
          id={`${id}-username`}
          name="username"
          value={username}
          autoComplete="username"
          minLength={3}
          maxLength={32}
          required
          disabled={locked}
          onChange={(event) => setUsername(event.target.value)}
        />
        <label htmlFor={`${id}-password`}>Password</label>
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          value={password}
          autoComplete={bootstrap ? 'new-password' : 'current-password'}
          minLength={12}
          maxLength={128}
          required={!locked}
          disabled={locked}
          onChange={(event) => setPassword(event.target.value)}
        />
        {bootstrap && (
          <>
            <label htmlFor={`${id}-setup`}>One-time setup secret</label>
            <input
              id={`${id}-setup`}
              name="setup-secret"
              type="password"
              value={setupToken}
              autoComplete="off"
              maxLength={1024}
              required={!locked}
              disabled={locked}
              onChange={(event) => setSetupToken(event.target.value)}
            />
            <p>
              Read the operator’s <code>server/data/setup-token</code>. This creates the first admin
              only; afterwards an admin must invite household members. There is no public signup.
              The secret and password are kept only in this tab’s memory.
            </p>
          </>
        )}
        <Button type="submit" disabled={locked || !acknowledged}>
          {bootstrap ? 'Create first owner' : 'Sign in'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={locked}
          onClick={() => {
            setBootstrap(!bootstrap)
            setPassword('')
            setSetupToken('')
            setValidation(undefined)
          }}
        >
          {bootstrap ? 'Back to sign in' : 'First run? Set up the owner'}
        </Button>
      </form>
      {validation && <p role="alert">{validation}</p>}
      <ActionFeedback action={action} />
    </section>
  )
}
