import type { Diagnostic } from '@openhome-core/remote'
import { useHousehold } from './workspace'

export function Diagnostics({ diagnostics, empty }: { diagnostics: Diagnostic[]; empty: string }) {
  if (!diagnostics.length) return <p>{empty}</p>
  return (
    <div className="hh-warning" role="note">
      <strong>Conversion diagnostics</strong>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}:${diagnostic.field ?? ''}:${index}`}>
            <code>{diagnostic.code}</code>
            {diagnostic.field ? ` (${diagnostic.field})` : ''}: {diagnostic.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function WorkspaceFeedback() {
  const { connection, error, notice, intent, retryIntent, busy, local, refresh } = useHousehold()
  const failure = error ?? connection.lastError
  return (
    <div className="hh-feedback" aria-live="polite">
      {!connection.coherent && (
        <p className="hh-warning" role="status">
          {connection.editing
            ? 'Staged snapshot retained.'
            : 'Showing the last synchronized snapshot, if available.'}{' '}
          The server view is not currently coherent; refresh before starting a new durable action.
        </p>
      )}
      {connection.conflicted && (
        <p className="hh-warning" role="alert">
          The server changed. Edits are retained. Refresh, explicitly three-way rebase, then review
          and save—or roll back. Nothing is automatically reapplied.
        </p>
      )}
      {failure && (
        <div className="hh-error" role="alert">
          <strong>{failure.code}</strong>
          {failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ''}: {failure.message}
          {failure.retryAfterSeconds !== undefined && (
            <p>
              Retry-After: {failure.retryAfterSeconds} seconds. No automatic mutation retry is
              scheduled.
            </p>
          )}
          {failure.details && (
            <details>
              <summary>Server error details</summary>
              <pre>{JSON.stringify(failure.details, null, 2)}</pre>
            </details>
          )}
          {!intent && (
            <button disabled={busy || connection.uncertain} onClick={() => void local(refresh)}>
              Retry read / refresh server
            </button>
          )}
        </div>
      )}
      {intent && (
        <div className="hh-warning" role="status">
          <strong>
            {intent.sending
              ? `${intent.label} in progress…`
              : `${intent.label}: outcome uncertain.`}
          </strong>
          <p>
            {intent.operation} · exact request identity <code>{intent.key ?? 'read-only'}</code>
          </p>
          <p>
            Keep this tab/session open. Do not start a new COPY or recreate this intent. Replaying
            sends the same retained key and body; it does not make another copy.
          </p>
          <button disabled={intent.sending} onClick={() => void retryIntent()}>
            Retry exact request
          </button>
        </div>
      )}
      {notice && (
        <p className="hh-success" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}
