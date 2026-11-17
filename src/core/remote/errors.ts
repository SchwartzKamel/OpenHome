import type { Result } from '@openhome-core/util/functional'
import type * as Wire from './wire-types'

export type RemoteErrorCode =
  | Wire.ErrorCode
  | 'network_error'
  | 'protocol_error'
  | 'unavailable'
  | 'insecure_transport'
  | 'identity_collision'
  | 'uncertain_commit'
  | 'cancelled'

export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly details?: Wire.ErrorDetails,
    readonly uncertain = false,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

// Keep the upstream string-error interface usable, without discarding structured failures.
export type RemoteResult<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'error'; readonly error: string; readonly failure: RemoteError }

export function failed<T = never>(failure: RemoteError): RemoteResult<T> {
  return { status: 'error', error: `${failure.code}: ${failure.message}`, failure }
}

export function remoteError(error: unknown): RemoteError {
  return error instanceof RemoteError
    ? error
    : new RemoteError('protocol_error', error instanceof Error ? error.message : 'Operation failed')
}

export function unavailable(operation: string, reason: string): never {
  throw new RemoteError('unavailable', `${operation} is unavailable: ${reason}`)
}

export function unwrap<T>(result: Result<T>): T {
  if (result.status === 'error') throw new RemoteError('unavailable', result.error)
  return result.data
}
