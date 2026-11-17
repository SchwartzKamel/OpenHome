// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { type Bundle, type IdMapping } from '@openhome-core/remote'
import { sha256 } from '@openhome-core/remote/crypto'
import { isObject, parseJson } from '@openhome-core/remote/validation'
import { id, realPokemon, status } from '@openhome-core/remote/__test__/support'
import { jsonBytes, validateBundle } from '../bundles'
import {
  buildFolderExport,
  canonicalFolderPaths,
  folderArchive,
  folderBanks,
  type FolderFile,
  inspectFolderExport,
  parseFolderBanks,
  parseFolderPokedex,
  readOpenHomeFolder,
  remapIdentityManifest,
} from '../folder-adapter'
import { makeProfile, readProfiles, PROFILE_STORAGE_KEY } from '../profiles'

function virtualFile(path: string, bytes: Uint8Array): FolderFile {
  return {
    name: path.split('/').at(-1) ?? path,
    webkitRelativePath: `storage/${path}`,
    size: bytes.length,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  }
}

function sourceFolder() {
  const fixture = parseJson(
    readFileSync(
      new URL('../../../../../contracts/folder-adapter.fixtures.json', import.meta.url),
      'utf8'
    )
  )
  if (!isObject(fixture) || !isObject(fixture.input))
    throw new Error('Invalid checked source mapping fixture')
  const stored = parseFolderBanks(fixture.input['banks.json'])
  const mon = realPokemon()
  const box = stored.banks[0].boxes.get(0)
  if (!box) throw new Error('Checked fixture has no first box')
  box.identifiers.set(0, mon.identifier)
  const banks = folderBanks(stored)
  const pokedex: unknown = fixture.input['pokedex.json']
  return {
    banks,
    pokedex,
    mon,
    files: [
      virtualFile('banks.json', jsonBytes(banks)),
      virtualFile('pokedex.json', jsonBytes(pokedex)),
      // The checked AA== fixture is mapping-only. Exercise the real WASM parser with real OHPKM.
      virtualFile('mons_v2/renamed-original.ohpkm', mon.binary),
    ],
  }
}

it('round-trips the exact source-backed sparse/null folder layout, history and real original OHPKM bytes through an actual ZIP', async () => {
  const input = sourceFolder()
  const preview = await readOpenHomeFolder(input.files)
  expect(preview.bundle.pokemon).toHaveLength(1)
  expect(preview.identity_map[0].openhome_id).toBe(input.mon.identifier)
  expect(preview.identity_map[0].pokemon_id).not.toBe(input.mon.identifier)
  expect(preview.bundle.content.banks[0].id).not.toBe(input.banks.banks[0].id)
  expect(preview.bundle.content.openhome_compatibility?.pokedex_history).toContainEqual({
    species: 150,
    form: 0,
    level: 'Seen',
    games: ['Red'],
    extra: [],
    flags: [],
    shiny_leaves: 0,
  })
  expect(preview.bundle.artifacts.map((entry) => entry.artifact.kind)).toEqual([
    'original_pkm',
    'canonical_ohpkm',
  ])
  const archive = folderArchive(inspectFolderExport(preview.bundle))
  const output = unzipSync(archive)
  expect(parseJson(new TextDecoder().decode(output['storage/banks.json']))).toEqual(input.banks)
  expect(parseJson(new TextDecoder().decode(output['storage/pokedex.json']))).toEqual(input.pokedex)
  const bytes = output[`storage/mons_v2/${input.mon.identifier}.ohpkm`]
  expect(bytes).toEqual(input.mon.binary)
  expect(sha256(bytes)).toBe(input.mon.output.sha256)
  const lossless: unknown = parseJson(
    new TextDecoder().decode(output['openhome-vault-bundle.json'])
  )
  expect(lossless).toEqual(preview.bundle)
  expect(output['openhome-identity-manifest.json']).toBeDefined()
  expect(Object.keys(output).some((path) => path.includes('renamed-original'))).toBe(false)
})

it('fails duplicate embedded identities and placements before any server request, rather than silently dropping a copy', async () => {
  const input = sourceFolder()
  await expect(
    readOpenHomeFolder([
      ...input.files,
      virtualFile('mons_v2/another-name.ohpkm', input.mon.binary),
    ])
  ).rejects.toThrow('Duplicate embedded OpenHome ID')
  const banks = structuredClone(input.banks)
  banks.banks[0].boxes[0].identifiers['1'] = input.mon.identifier
  expect(() => parseFolderBanks(banks)).toThrow('placed more than once')
  banks.banks[0].boxes[0].identifiers = { '30': input.mon.identifier }
  expect(() => parseFolderBanks(banks)).toThrow('cannot be truncated')
})

it('blocks colliding server copies by default, requires a valid explicit choice, and discloses every omitted UUID and placement', async () => {
  const input = sourceFolder()
  const { bundle } = await readOpenHomeFolder(input.files)
  const original = bundle.pokemon[0]
  const copy = {
    ...structuredClone(original),
    id: id(501),
    metadata: { ...original.metadata, pokemon_id: id(501) },
    original_artifact_ids: [id(502)],
    ohpkm_artifact_id: id(503),
  }
  const firstOriginal = bundle.artifacts.find(
    (entry) => entry.artifact.id === original.original_artifact_ids[0]
  )
  const firstCanonical = bundle.artifacts.find(
    (entry) => entry.artifact.id === original.ohpkm_artifact_id
  )
  if (!firstOriginal || !firstCanonical) throw new Error('No actual fixture artifacts')
  bundle.pokemon.push(copy)
  bundle.artifacts.push(
    { ...structuredClone(firstOriginal), artifact: { ...firstOriginal.artifact, id: id(502) } },
    { ...structuredClone(firstCanonical), artifact: { ...firstCanonical.artifact, id: id(503) } }
  )
  bundle.content.metadata.push(copy.metadata)
  const bank = bundle.content.banks[0]
  const box = bank.boxes[0]
  box.slots[1] = copy.id
  const plan = inspectFolderExport(bundle)
  expect(plan.collisions[0].copies.map((entry) => entry.pokemon_id)).toEqual([original.id, copy.id])
  expect(() => buildFolderExport(plan)).toThrow('Choose exactly one copy and one valid placement')
  expect(() =>
    buildFolderExport(plan, {
      [input.mon.identifier]: {
        pokemon_id: original.id,
        placement: { bank_id: id(999), box_id: box.id, slot: 0 },
      },
    })
  ).toThrow('unknown or occupied')
  const choice = {
    [input.mon.identifier]: {
      pokemon_id: original.id,
      placement: { bank_id: bank.id, box_id: box.id, slot: 0 },
    },
  }
  const output = buildFolderExport(plan, choice)
  expect(output.manifest.omitted_pokemon_ids).toEqual([copy.id])
  expect(output.manifest.omitted_placements).toEqual([
    {
      pokemon_id: copy.id,
      placement: { bank_id: bank.id, box_id: box.id, slot: 1 },
    },
  ])
  expect(Object.keys(output.files).filter((path) => path.endsWith('.ohpkm'))).toHaveLength(1)
  expect(output.files[`storage/mons_v2/${input.mon.identifier}.ohpkm`]).toEqual(input.mon.binary)
  const zip = unzipSync(folderArchive(plan, choice))
  expect(parseJson(new TextDecoder().decode(zip['openhome-vault-bundle.json']))).toEqual(bundle)
})

it('rejects unknown manifest members, legacy history, unsafe paths and oversized files before heavy binary reads', async () => {
  const input = sourceFolder()
  expect(() =>
    parseFolderBanks({ ...input.banks, token: 'not-an-allowed-manifest-member' })
  ).toThrow('exactly')
  expect(() => parseFolderPokedex({ byDexNumber: {} })).toThrow('canonical decimal')
  expect(() => parseFolderPokedex({ '1': { formes: {} } })).toThrow('exactly')
  const read = vi.fn(async () => new ArrayBuffer(0))
  const unsafe: FolderFile = {
    name: 'banks.json',
    webkitRelativePath: 'storage/../banks.json',
    size: 2,
    arrayBuffer: read,
  }
  expect(() => canonicalFolderPaths([unsafe])).toThrow('without traversal')
  expect(read).not.toHaveBeenCalled()
  const oversized: FolderFile = {
    name: 'huge.ohpkm',
    webkitRelativePath: 'storage/mons_v2/huge.ohpkm',
    size: 1_048_577,
    arrayBuffer: read,
  }
  await expect(readOpenHomeFolder([...input.files.slice(0, 2), oversized])).rejects.toThrow(
    'before reading'
  )
  expect(read).not.toHaveBeenCalled()
})

it('enforces artifact roles, physical and repeated-payload wire quotas without trusting a JSON filename', async () => {
  const { bundle } = await readOpenHomeFolder(sourceFolder().files)
  const wrongRole: Bundle = structuredClone(bundle)
  wrongRole.artifacts[0].artifact.kind = 'original_save'
  expect(() => validateBundle(wrongRole)).toThrow('role')
  const stats = validateBundle(bundle)
  expect(stats.blobBytes).toBe(bundle.artifacts[0].bytes.byte_length)
  const limits = { ...status.limits, bundle_body_bytes: stats.wireBytes - 1 }
  expect(() => validateBundle(bundle, limits)).toThrow('exact wire quota')
  expect(() =>
    validateBundle(bundle, { ...status.limits, vault_blob_bytes: stats.blobBytes - 1 })
  ).toThrow('BLOB quota')
})

it('remaps only logical UUID references after import, preserving embedded OpenHome IDs and external folder UUIDs', async () => {
  const preview = await readOpenHomeFolder(sourceFolder().files)
  const link = preview.identity_map[0]
  if (!link.placement) throw new Error('No checked fixture placement')
  const mappings: IdMapping[] = [
    { kind: 'pokemon', source_id: link.pokemon_id, destination_id: id(601) },
    { kind: 'bank', source_id: link.placement.bank_id, destination_id: id(602) },
    { kind: 'box', source_id: link.placement.box_id, destination_id: id(603) },
  ]
  const result = remapIdentityManifest(preview.identity_map, mappings)
  expect(result).toEqual([
    {
      openhome_id: link.openhome_id,
      pokemon_id: id(601),
      placement: { bank_id: id(602), box_id: id(603), slot: 0 },
    },
  ])
  expect(() => remapIdentityManifest(preview.identity_map, [])).toThrow('mapping omitted')
})

it('saved server profiles reject credentials, paths and unknown fields and never persist authentication candidates', () => {
  expect(() => makeProfile('Unsafe', 'https://user:password@home.test')).toThrow(
    'without credentials'
  )
  expect(() => makeProfile('Unsafe', 'https://home.test/api')).toThrow('without credentials')
  expect(() =>
    readProfiles({
      getItem: () =>
        JSON.stringify([
          {
            name: 'Home',
            origin: 'https://home.test',
            token: 'forbidden',
          },
        ]),
    })
  ).toThrow('only a name and origin')
  expect(
    readProfiles({
      getItem: (key) =>
        key === PROFILE_STORAGE_KEY ? '[{"name":"Home","origin":"https://home.test/"}]' : null,
    })
  ).toEqual([{ name: 'Home', origin: 'https://home.test' }])
})
