import { decodeBytes, type Bundle, type Limits, RemoteError } from '@openhome-core/remote'
import { validateContent } from '@openhome-core/remote/state'
import { parseJson, parseWire } from '@openhome-core/remote/validation'

export const MAX_BUNDLE_BYTES = 201_326_592
export const MAX_METADATA_BYTES = 16_777_216
export const MAX_BLOB_BYTES = 134_217_728

export interface BundleBudget {
  wire: number
  metadata: number
  blobs: number
  pokemon: number
  pkm: number
  save: number
}

export function bundleBudget(limits?: Limits): BundleBudget {
  return {
    wire: Math.min(MAX_BUNDLE_BYTES, limits?.bundle_body_bytes ?? MAX_BUNDLE_BYTES),
    metadata: Math.min(MAX_METADATA_BYTES, limits?.vault_metadata_bytes ?? MAX_METADATA_BYTES),
    blobs: Math.min(MAX_BLOB_BYTES, limits?.vault_blob_bytes ?? MAX_BLOB_BYTES),
    pokemon: Math.min(10_000, limits?.pokemon_per_vault ?? 10_000),
    pkm: Math.min(1_048_576, limits?.pkm_bytes ?? 1_048_576),
    save: Math.min(16_777_216, limits?.save_bytes ?? 16_777_216),
  }
}

function reject(message: string): never {
  throw new RemoteError('invalid_request', message)
}

export function validateBundle(bundle: Bundle, limits?: Limits, importMode?: 'merge' | 'replace') {
  parseWire('Bundle', bundle)
  const budget = bundleBudget(limits)
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify(bundle, (key, value: unknown) => (key === 'data_base64' ? '' : value))
  ).length
  const wireBytes =
    metadataBytes + bundle.artifacts.reduce((sum, entry) => sum + entry.bytes.data_base64.length, 0)
  const requestBytes =
    wireBytes +
    (importMode
      ? new TextEncoder().encode(JSON.stringify({ mode: importMode, bundle: null })).length - 4
      : 0)
  const blobs = new Map<string, { length: number; base64: string }>()
  const artifacts = new Map(bundle.artifacts.map((entry) => [entry.artifact.id, entry]))
  const pokemon = new Set(bundle.pokemon.map((entry) => entry.id))
  const metadataById = new Map(bundle.content.metadata.map((entry) => [entry.pokemon_id, entry]))
  if (pokemon.size !== bundle.pokemon.length || artifacts.size !== bundle.artifacts.length)
    reject('Bundle contains duplicate logical record or artifact IDs.')
  if (
    pokemon.size > budget.pokemon ||
    metadataBytes > budget.metadata ||
    requestBytes > budget.wire
  )
    throw new RemoteError(
      'limit_exceeded',
      'Bundle exceeds the collection, metadata or exact wire quota.'
    )
  validateContent(bundle.content, pokemon)
  for (const { artifact, bytes } of bundle.artifacts) {
    const save = 'family' in bytes
    const saveRole = artifact.kind === 'original_save' || artifact.kind === 'prepared_save'
    if (
      save !== saveRole ||
      artifact.format !== (save ? bytes.family : bytes.format) ||
      artifact.sha256 !== bytes.sha256 ||
      artifact.byte_length !== bytes.byte_length ||
      (artifact.kind === 'canonical_ohpkm' && (save || bytes.format !== 'ohpkm'))
    )
      reject('Bundle artifact role, digest, length or format is inconsistent.')
    if (bytes.byte_length < 1 || bytes.byte_length > (save ? budget.save : budget.pkm))
      throw new RemoteError('limit_exceeded', 'A bundle binary exceeds the server byte cap.')
    const previous = blobs.get(bytes.sha256)
    if (
      previous &&
      (previous.length !== bytes.byte_length || previous.base64 !== bytes.data_base64)
    )
      reject('A shared digest identifies different bundle bytes.')
    blobs.set(bytes.sha256, { length: bytes.byte_length, base64: bytes.data_base64 })
  }
  const blobBytes = [...blobs.values()].reduce((sum, entry) => sum + entry.length, 0)
  if (blobBytes > budget.blobs)
    throw new RemoteError('limit_exceeded', 'Bundle exceeds the distinct retained BLOB quota.')
  for (const record of bundle.pokemon) {
    const canonical = artifacts.get(record.ohpkm_artifact_id)
    if (!canonical || canonical.artifact.kind !== 'canonical_ohpkm')
      reject('A Pokemon has no canonical OHPKM artifact.')
    for (const id of record.original_artifact_ids) {
      if (artifacts.get(id)?.artifact.kind !== 'original_pkm')
        reject('A Pokemon original must be a per-Pokemon original_pkm, never a whole save.')
    }
    const metadata = metadataById.get(record.id)
    if (
      record.metadata.pokemon_id !== record.id ||
      !metadata ||
      metadata.favorite !== record.metadata.favorite ||
      JSON.stringify(metadata.tags) !== JSON.stringify(record.metadata.tags)
    )
      reject('Pokemon metadata disagrees with the bundle content.')
  }
  // Admission is checked before decoding large payloads, and repeated BLOBs are verified once.
  for (const [digest, blob] of blobs) {
    decodeBytes({ data_base64: blob.base64, sha256: digest, byte_length: blob.length })
  }
  return { metadataBytes, wireBytes, blobBytes }
}

export async function readBundleFile(file: File, limits?: Limits): Promise<Bundle> {
  const budget = bundleBudget(limits)
  const wrapper =
    new TextEncoder().encode(JSON.stringify({ mode: 'replace', bundle: null })).length - 4
  if (file.size < 2 || file.size > budget.wire - wrapper)
    throw new RemoteError(
      'limit_exceeded',
      'Select a JSON bundle within this server’s wire byte cap.'
    )
  const bytes = await file.arrayBuffer()
  if (bytes.byteLength !== file.size || bytes.byteLength > budget.wire)
    throw new RemoteError('limit_exceeded', 'The selected bundle size changed while reading.')
  const bundle = parseWire(
    'Bundle',
    parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  )
  validateBundle(bundle, limits, 'replace')
  return bundle
}

export function jsonBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value))
}
