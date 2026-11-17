import SHA256 from 'crypto-js/sha256'
import WordArray from 'crypto-js/lib-typedarrays'
import { v4 as uuid } from 'uuid'
import { RemoteError } from './errors'
import { parseWire } from './validation'
import type { BearerToken, PkmInput, PokemonFormat, SaveFamily, SaveInput } from './wire-types'

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!globalThis.crypto?.getRandomValues) {
    throw new RemoteError(
      'unavailable',
      'A platform CSPRNG is required; no weak random fallback is allowed'
    )
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

export function newId(): string {
  // uuid's native randomUUID optimization requires a secure context; its explicit random input does not.
  return uuid({ random: randomBytes(16) })
}

export function newBearer(): BearerToken {
  return parseWire(
    'BearerToken',
    `ohs_${encodeBase64(randomBytes(32)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`
  )
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  }
  return btoa(binary)
}

export function sha256(bytes: Uint8Array): string {
  // crypto.subtle is absent on many explicit HTTP LAN origins; crypto-js is already an upstream dependency.
  return SHA256(WordArray.create(new Uint8Array(bytes))).toString()
}

export function decodeBytes(input: {
  data_base64: string
  sha256: string
  byte_length: number
}): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(input.data_base64), (character) => character.charCodeAt(0))
  } catch {
    throw new RemoteError('invalid_bytes', 'The server returned invalid base64')
  }
  if (bytes.length !== input.byte_length || encodeBase64(bytes) !== input.data_base64) {
    throw new RemoteError(
      'invalid_bytes',
      'The server returned noncanonical bytes or an incorrect length'
    )
  }
  if (sha256(bytes) !== input.sha256) {
    throw new RemoteError('checksum_mismatch', 'The returned bytes failed SHA-256 verification')
  }
  return bytes
}

export function pokemonInput(bytes: Uint8Array, format: PokemonFormat | 'auto' = 'auto'): PkmInput {
  return parseWire('PkmInput', {
    data_base64: encodeBase64(bytes),
    sha256: sha256(bytes),
    format_hint: format,
  })
}

export function saveInput(bytes: Uint8Array, family: SaveFamily | 'auto' = 'auto'): SaveInput {
  return parseWire('SaveInput', {
    data_base64: encodeBase64(bytes),
    sha256: sha256(bytes),
    family_hint: family,
  })
}
