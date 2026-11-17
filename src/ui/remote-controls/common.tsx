import { type RemoteError, type RemoteBackend, parseWire } from '@openhome-core/remote'
import { AlertDialog, Button, Callout, Flex } from '@radix-ui/themes'
import { type PropsWithChildren, useId, useLayoutEffect, useState } from 'react'
import type { PreparedAction } from './safety'

export function FailureNotice({ failure }: { failure?: RemoteError }) {
  if (!failure) return null
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Text>
        {failure.code === 'unauthorized'
          ? 'Authentication failed. Private data has been cleared; sign in again.'
          : `The server request could not be completed (${failure.code}${failure.httpStatus ? `, HTTP ${failure.httpStatus}` : ''}).`}
        {failure.uncertain &&
          ' Outcome uncertain: the server may have committed. The exact request is retained; retry that same request, not a new intent.'}
        {failure.retryAfterSeconds !== undefined &&
          ` Server Retry-After: ${failure.retryAfterSeconds} seconds.`}
      </Callout.Text>
    </Callout.Root>
  )
}

export function useSecondsUntil(time: number) {
  const [now, setNow] = useState(Date.now)
  useLayoutEffect(() => {
    setNow(Date.now())
    if (time <= Date.now()) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [time])
  return Math.max(0, Math.ceil((time - now) / 1000))
}

export function ActionFeedback<T>({ action }: { action: PreparedAction<T> }) {
  const remaining = useSecondsUntil(action.retryAt)
  return (
    <>
      {action.busy && <p role="status">Waiting for the server…</p>}
      <FailureNotice failure={action.failure} />
      {action.admissionProblem && (
        <p role="alert">
          {action.admissionProblem} This attempt sent no mutation; the exact prepared request is
          retained.
        </p>
      )}
      {action.retained && !action.busy && (
        <Flex gap="2" wrap="wrap" align="center">
          <Button type="button" disabled={remaining > 0} onClick={() => void action.retry()}>
            Retry same request{remaining > 0 ? ` (${remaining}s)` : ''}
          </Button>
          {!action.failure?.uncertain && (
            <Button type="button" variant="soft" onClick={action.reset}>
              Dismiss request / edit
            </Button>
          )}
        </Flex>
      )}
    </>
  )
}

export function ConfirmAction({
  title,
  action,
  children,
  onCancel,
  onConfirm,
  busy = false,
}: PropsWithChildren<{
  title: string
  action: string
  onCancel: () => void
  onConfirm: () => void
  busy?: boolean
}>) {
  const [checked, setChecked] = useState(false)
  const id = useId()
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <AlertDialog.Content maxWidth="32rem">
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>
          Review the consequences before confirming.
        </AlertDialog.Description>
        <div>{children}</div>
        <label className="remote-check" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            disabled={busy}
          />
          I understand and confirm this action.
        </label>
        <Flex gap="3" mt="4" justify="end" wrap="wrap">
          <Button type="button" variant="soft" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" color="red" disabled={!checked || busy} onClick={onConfirm}>
            {action}
          </Button>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  )
}

export function vaultMutationAdmission(backend: RemoteBackend): string | undefined {
  const connection = backend.connection
  return connection.editing || connection.uncertain
    ? 'Resolve or explicitly roll back collection edits and resolve commit uncertainty before sending a collection mutation.'
    : undefined
}

export async function freshVaultTag(backend: RemoteBackend) {
  const initialProblem = vaultMutationAdmission(backend)
  if (initialProblem) throw new Error(initialProblem)
  const response = await backend.api.call('getVault', { query: { view: 'full' } })
  const currentProblem = vaultMutationAdmission(backend)
  if (currentProblem) throw new Error(currentProblem)
  if (response.data.view !== 'full') throw new Error('The server did not return a full vault.')
  if (response.data.reservations.length > 0) {
    throw new Error('Finish reserved trades or transfers before restoring or importing.')
  }
  return parseWire('VaultETag', response.etag)
}

export function MappingResult({
  revision,
  mappings,
}: {
  revision: number
  mappings: readonly { kind: string; source_id: string; destination_id: string }[]
}) {
  return (
    <details className="remote-mapping">
      <summary>
        Server confirmed revision {revision} · {mappings.length} ID mappings
      </summary>
      <ul>
        {mappings.map((mapping) => (
          <li key={`${mapping.kind}-${mapping.source_id}`}>
            {mapping.kind}: <code>{mapping.source_id}</code> → <code>{mapping.destination_id}</code>
          </li>
        ))}
      </ul>
    </details>
  )
}
