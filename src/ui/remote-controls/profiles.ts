import { RemoteError } from '@openhome-core/remote/errors'
import { isObject, parseJson } from '@openhome-core/remote/validation'

export interface ServerProfile {
  name: string
  origin: string
}

export const PROFILE_STORAGE_KEY = 'openhome.server-profiles.v1'

export function serverOrigin(address: string): string {
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    throw new RemoteError('invalid_request', 'Enter a complete HTTP or HTTPS server origin.')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new RemoteError(
      'invalid_request',
      'Use only the server origin, without credentials, paths, query strings or fragments.'
    )
  }
  return url.origin
}

export function makeProfile(name: string, address: string): ServerProfile {
  const trimmed = name.trim()
  if (!trimmed || Array.from(trimmed).length > 64)
    throw new RemoteError('invalid_request', 'Profile names must contain 1–64 characters.')
  return { name: trimmed, origin: serverOrigin(address) }
}

export function readProfiles(storage: Pick<Storage, 'getItem'>): ServerProfile[] {
  const text = storage.getItem(PROFILE_STORAGE_KEY)
  if (text === null) return []
  if (text.length > 32_768) throw new Error('Saved server profiles exceed their size limit.')
  const value = parseJson(text)
  if (!Array.isArray(value) || value.length > 16)
    throw new Error('Saved server profiles are not a supported profile list.')
  return value.map((profile) => {
    if (
      !isObject(profile) ||
      Object.keys(profile).length !== 2 ||
      typeof profile.name !== 'string' ||
      typeof profile.origin !== 'string'
    ) {
      throw new Error('Saved profiles may contain only a name and origin.')
    }
    return makeProfile(profile.name, profile.origin)
  })
}

export function saveProfile(
  storage: Pick<Storage, 'setItem'>,
  profiles: readonly ServerProfile[],
  profile: ServerProfile
): ServerProfile[] {
  const next = [...profiles.filter((item) => item.origin !== profile.origin), profile]
  if (next.length > 16) throw new Error('Remove a saved profile before adding another (limit 16).')
  storage.setItem(
    PROFILE_STORAGE_KEY,
    JSON.stringify(next.map(({ name, origin }) => ({ name, origin })))
  )
  return next
}
