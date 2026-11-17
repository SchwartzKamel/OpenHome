import type BackendInterface from '@openhome-core/backend/backendInterface'
import { RemoteError } from './errors'

export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function loadLocalBackend(): Promise<BackendInterface> {
  if (!isDesktopShell()) {
    throw new RemoteError('unavailable', 'Local mode requires the actual OpenHome desktop shell')
  }
  // Keep the original singleton, paths, native state and listener implementations intact.
  return (await import('@openhome-core/tauri/backend')).TauriBackend
}
