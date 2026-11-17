import {
  decodeBytes,
  newId,
  type Bundle,
  type IdMapping,
  type Limits,
  type ObservedPokemon,
  type OpenHomeIdentityLink,
  type OpenHomePokedexEntry,
  type SlotAddress,
  RemoteError,
} from '@openhome-core/remote'
import { encodeBase64, sha256 } from '@openhome-core/remote/crypto'
import {
  IdentityMap,
  projectBanks,
  readOhpkm,
  translateBanks,
} from '@openhome-core/remote/identity'
import { validateContent } from '@openhome-core/remote/state'
import { isObject, parseJson, parseWire } from '@openhome-core/remote/validation'
import type { SimpleOpenHomeBox, StoredBankData } from '@openhome-core/save/util/storage'
import { OriginGames } from '@pkm-rs/pkg'
import { zipSync } from 'fflate'
import { bundleBudget, jsonBytes, validateBundle } from './bundles'

export interface FolderFile {
  readonly name: string
  readonly size: number
  readonly webkitRelativePath?: string
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface FolderImportPreview {
  bundle: Bundle
  identity_map: OpenHomeIdentityLink[]
  original_bytes: number
}

export interface FolderCopy {
  pokemon_id: string
  placement: SlotAddress | null
}

export interface FolderCollision {
  openhome_id: string
  copies: FolderCopy[]
}

export interface CopyChoice {
  pokemon_id: string
  placement: SlotAddress
}

export interface FolderExportPlan {
  readonly bundle: Bundle
  readonly files: ReadonlyMap<string, { openhome_id: string; bytes: Uint8Array<ArrayBuffer> }>
  readonly collisions: readonly FolderCollision[]
}

function invalid(message: string): never {
  throw new RemoteError('invalid_request', message)
}

function object(value: unknown, fields: readonly string[], label: string) {
  if (
    !isObject(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    invalid(
      `${label} must contain exactly: ${fields.join(', ')}. Upgrade legacy folders in OpenHome first; no fields were discarded.`
    )
  return value
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(`${label} is outside the canonical layout range.`)
  return value
}

function array(value: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(`${label} has an unsupported number of entries.`)
  return value
}

function decimal(key: string, min: number, max: number, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) invalid(`${label} requires canonical decimal keys.`)
  return integer(Number(key), min, max, label)
}

export function parseFolderBanks(value: unknown): StoredBankData {
  const root = object(value, ['banks', 'current_bank'], 'banks.json')
  const ids = new Set<string>()
  const placed = new Set<string>()
  function id(value: unknown) {
    const parsed = parseWire('Id', value)
    if (ids.has(parsed)) invalid('Folder bank/box UUIDs must be globally unique.')
    ids.add(parsed)
    return parsed
  }
  const banks = array(root.banks, 1, 16, 'Banks').map((value, bankIndex) => {
    const bank = object(value, ['id', 'name', 'index', 'current_box', 'boxes'], 'Folder bank')
    if (bank.index !== bankIndex) invalid('Bank indices must be consecutive and match array order.')
    const boxes = array(bank.boxes, 1, 64, 'Boxes').map(
      (value, boxIndex): [number, SimpleOpenHomeBox] => {
        const box = object(value, ['id', 'name', 'index', 'identifiers'], 'Folder box')
        if (box.index !== boxIndex)
          invalid('Box indices must be consecutive and match array order.')
        if (!isObject(box.identifiers)) invalid('Box identifiers must be a sparse JSON object.')
        const identifiers = new Map<number, string>()
        for (const [slot, value] of Object.entries(box.identifiers)) {
          const index = decimal(slot, 0, 29, 'Slot (desktop slots 30–119 cannot be truncated)')
          const identifier = parseWire('OpenHomeId', value)
          if (placed.has(identifier)) invalid('An embedded OpenHome ID is placed more than once.')
          placed.add(identifier)
          identifiers.set(index, identifier)
        }
        return [
          boxIndex,
          {
            id: id(box.id),
            index: boxIndex,
            name: parseWire('OpenHomeSourceName', box.name),
            identifiers,
          },
        ]
      }
    )
    return {
      id: id(bank.id),
      name: parseWire('OpenHomeSourceName', bank.name),
      index: bankIndex,
      current_box: integer(bank.current_box, 0, boxes.length - 1, 'Current box'),
      boxes: new Map(boxes),
    }
  })
  return {
    banks,
    current_bank: integer(root.current_bank, 0, banks.length - 1, 'Current bank'),
  }
}

export function parseFolderPokedex(value: unknown): OpenHomePokedexEntry[] {
  if (!isObject(value)) invalid('pokedex.json must be a national-dex-number-keyed object.')
  const result: OpenHomePokedexEntry[] = []
  for (const [dex, dexValue] of Object.entries(value)) {
    const species = decimal(dex, 1, 65_535, 'Pokedex species')
    const entry = object(dexValue, ['forms'], 'Pokedex species entry')
    if (!isObject(entry.forms)) invalid('Pokedex forms must be a decimal-form-keyed object.')
    for (const [key, value] of Object.entries(entry.forms)) {
      if (result.length >= 16_384)
        throw new RemoteError('limit_exceeded', 'Pokedex history exceeds 16,384 entries.')
      const form = decimal(key, 0, 65_535, 'Pokedex form')
      const fields = object(
        value,
        ['level', 'games', 'extra', 'flags', 'shiny_leaves'],
        'Pokedex form'
      )
      const parsed = parseWire('OpenHomePokedexEntry', { ...fields, species, form })
      if (!parsed.games.every((game) => OriginGames.isOriginGameString(game)))
        invalid(
          'Pokedex games must be actual pinned OriginGame variants; spellings are not guessed.'
        )
      result.push(parsed)
    }
  }
  return result.sort((left, right) => left.species - right.species || left.form - right.form)
}

export function folderPokedex(history: readonly OpenHomePokedexEntry[]) {
  const result: Record<
    string,
    { forms: Record<string, Omit<OpenHomePokedexEntry, 'species' | 'form'>> }
  > = {}
  for (const entry of history) {
    const { species, form, ...fields } = parseWire('OpenHomePokedexEntry', entry)
    const speciesEntry = result[String(species)] ?? { forms: {} }
    if (Object.hasOwn(speciesEntry.forms, String(form)))
      invalid('Duplicate historical Pokedex form.')
    speciesEntry.forms[String(form)] = fields
    result[String(species)] = speciesEntry
  }
  return result
}

export function folderBanks(stored: StoredBankData) {
  return {
    banks: stored.banks.map((bank) => ({
      id: bank.id,
      name: bank.name,
      index: bank.index,
      current_box: bank.current_box,
      boxes: [...bank.boxes.values()].map((box) => ({
        id: box.id,
        name: box.name,
        index: box.index,
        identifiers: Object.fromEntries(
          [...box.identifiers].map(([slot, id]) => [String(slot), id])
        ),
      })),
    })),
    current_bank: stored.current_bank,
  }
}

export function canonicalFolderPaths(files: readonly FolderFile[]): Map<string, FolderFile> {
  const result = new Map<string, FolderFile>()
  let root: string | undefined
  for (const file of files) {
    const raw = file.webkitRelativePath || file.name
    const parts = raw.split('/')
    if (
      !raw ||
      /[\\:%]/u.test(raw) ||
      Array.from(raw).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      parts.some((part) => !part || part === '.' || part === '..')
    )
      invalid(
        'Folder paths must be canonical relative paths without traversal or encoded separators.'
      )
    if (file.webkitRelativePath) {
      const first = parts.shift()
      if (!first || (root !== undefined && first !== root))
        invalid('Select a single storage folder, not multiple unrelated roots.')
      root = first
    }
    const path = parts.join('/')
    if (path !== 'banks.json' && path !== 'pokedex.json' && !/^mons_v2\/[^/]+\.ohpkm$/u.test(path))
      invalid(
        'Select only storage/banks.json, storage/pokedex.json and storage/mons_v2/*.ohpkm. Other files are not read.'
      )
    if (result.has(path)) invalid('The selected folder contains duplicate canonical file paths.')
    result.set(path, file)
  }
  if (!result.has('banks.json') || !result.has('pokedex.json'))
    invalid('The selected storage folder must contain banks.json and pokedex.json.')
  return result
}

async function fileBytes(file: FolderFile, maximum: number) {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximum)
    throw new RemoteError('limit_exceeded', 'A selected folder file exceeds its byte cap.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== file.size || bytes.length > maximum)
    throw new RemoteError('limit_exceeded', 'A selected folder file changed size while reading.')
  return bytes
}

function observation(bytes: Uint8Array): { openhome_id: string; observed: ObservedPokemon } {
  const mon = readOhpkm(bytes)
  try {
    const backup = mon.originalData
    const backupGenerations: Readonly<Record<number, number>> = {
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 6,
      7: 7,
      8: 7,
      9: 8,
      10: 8,
      11: 8,
      12: 9,
      13: 9,
    }
    const backupGeneration = backup ? backupGenerations[backup.tag] : undefined
    backup?.free()
    const generation = Number(OriginGames.generation(mon.gameOfOrigin)) || backupGeneration
    const sections = mon.getSectionBytes()
    if (!isObject(sections)) invalid('OHPKM section bytes are unavailable.')
    const rawMain: unknown = sections.MainData
    if (
      !(rawMain instanceof Uint8Array) &&
      (!Array.isArray(rawMain) ||
        !rawMain.every(
          (byte: unknown) =>
            typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255
        ))
    )
      invalid('OHPKM main section is not a byte array.')
    const main = Uint8Array.from(rawMain)
    if (main.length < 76) invalid('OHPKM main data cannot supply observations.')
    const ribbons: number[] = []
    // Frozen engine/src/pokemon.mjs observed(): wire ribbon IDs are bit positions + 1.
    for (let bit = 0; bit < 22 * 8; bit++)
      if (main[54 + (bit >> 3)] & (1 << (bit & 7))) ribbons.push(bit + 1)
    return {
      openhome_id: mon.openhomeId,
      observed: parseWire('ObservedPokemon', {
        species: mon.nationalDex,
        form: mon.formIndex,
        nickname: mon.nickname,
        level: mon.getLevel(),
        shiny: mon.isShiny(),
        moves: [...new Set(mon.moves.filter((move) => move !== 0))],
        ability: mon.ability?.index || null,
        ribbons,
        source_generation: generation,
      }),
    }
  } finally {
    mon.free()
  }
}

export async function readOpenHomeFolder(
  selection: readonly FolderFile[],
  limits?: Limits
): Promise<FolderImportPreview> {
  const budget = bundleBudget(limits)
  if (selection.length > budget.pokemon + 2)
    throw new RemoteError('limit_exceeded', 'Selected folder contains too many files.')
  const files = canonicalFolderPaths(selection)
  const banksFile = files.get('banks.json')
  const dexFile = files.get('pokedex.json')
  if (!banksFile || !dexFile) invalid('Folder manifests are missing.')
  const binaries = [...files.entries()].filter(([path]) => path.startsWith('mons_v2/'))
  const rawTotal = binaries.reduce((sum, [, file]) => sum + file.size, 0)
  if (
    binaries.length > budget.pokemon ||
    binaries.some(
      ([, file]) => !Number.isSafeInteger(file.size) || file.size < 1 || file.size > budget.pkm
    ) ||
    banksFile.size + dexFile.size > budget.metadata ||
    rawTotal > budget.blobs ||
    binaries.reduce((sum, [, file]) => sum + Math.ceil(file.size / 3) * 4 * 2, 0) > budget.wire
  )
    throw new RemoteError(
      'limit_exceeded',
      'Folder exceeds the record, binary, metadata or bundle wire cap before reading.'
    )
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const stored = parseFolderBanks(
    parseJson(decoder.decode(await fileBytes(banksFile, budget.metadata)))
  )
  const history = parseFolderPokedex(
    parseJson(decoder.decode(await fileBytes(dexFile, budget.metadata)))
  )
  const now = new Date().toISOString()
  const identities = new IdentityMap()
  const identityIds = new Set<string>()
  const pokemon: Bundle['pokemon'] = []
  const artifacts: Bundle['artifacts'] = []
  const lookups: Bundle['content']['lookups'] = []
  const links: OpenHomeIdentityLink[] = []
  for (const [, file] of binaries) {
    const raw = await fileBytes(file, budget.pkm)
    const { openhome_id, observed } = observation(raw)
    if (identityIds.has(openhome_id))
      invalid(
        `Duplicate embedded OpenHome ID ${openhome_id}. Renamed files do not create independent identities.`
      )
    identityIds.add(openhome_id)
    const pokemonId = newId()
    const originalId = newId()
    const canonicalId = newId()
    const digest = sha256(raw)
    const bytes = {
      format: 'ohpkm' as const,
      data_base64: encodeBase64(raw),
      sha256: digest,
      byte_length: raw.length,
    }
    const metadata = { pokemon_id: pokemonId, favorite: false, tags: [] }
    pokemon.push({
      id: pokemonId,
      observed,
      metadata,
      original_artifact_ids: [originalId],
      ohpkm_artifact_id: canonicalId,
      imported_at: now,
    })
    artifacts.push(
      {
        artifact: {
          id: originalId,
          kind: 'original_pkm',
          format: 'ohpkm',
          sha256: digest,
          byte_length: raw.length,
          created_at: now,
        },
        bytes,
      },
      {
        artifact: {
          id: canonicalId,
          kind: 'canonical_ohpkm',
          format: 'ohpkm',
          sha256: digest,
          byte_length: raw.length,
          created_at: now,
        },
        bytes,
      }
    )
    identities.register(pokemonId, raw)
    links.push({ openhome_id, pokemon_id: pokemonId, placement: null })
    lookups.push({ source_sha256: digest, pokemon_id: pokemonId })
  }
  const layout = {
    version: 1 as const,
    current_bank: stored.current_bank,
    pokedex_history: history,
    banks: stored.banks.map((bank) => ({
      bank_id: newId(),
      folder_id: bank.id,
      index: bank.index,
      source_name: bank.name,
      current_box: bank.current_box,
      boxes: [...bank.boxes.values()].map((box) => ({
        box_id: newId(),
        folder_id: box.id,
        index: box.index,
        source_name: box.name,
      })),
    })),
  }
  const base: Bundle['content'] = {
    banks: [],
    // Folder files contain no account settings. These are explicit v1 initial settings,
    // disclosed in the import preview, not substitutes for a failed server read.
    settings: {
      theme: 'system',
      language: 'en',
      sort: 'manual',
      snapshot_retention: 10,
      default_strategy_id: null,
    },
    metadata: pokemon.map((record) => record.metadata),
    lookups,
    conversion_strategies: [],
    openhome_compatibility: layout,
  }
  const mapped = translateBanks(stored, base, identities)
  const bundle = parseWire('Bundle', {
    format: 'openhome-vault-bundle',
    version: 1,
    source_revision: 0,
    content: { ...base, ...mapped },
    pokemon,
    artifacts,
  })
  validateBundle(bundle, limits, 'replace')
  for (const link of links) link.placement = placementOf(bundle, link.pokemon_id)
  return { bundle, identity_map: links, original_bytes: rawTotal }
}

function placementOf(bundle: Bundle, pokemonId: string): SlotAddress | null {
  for (const bank of bundle.content.banks)
    for (const box of bank.boxes) {
      const slot = box.slots.indexOf(pokemonId)
      if (slot !== -1) return { bank_id: bank.id, box_id: box.id, slot }
    }
  return null
}

export function inspectFolderExport(bundle: Bundle, limits?: Limits): FolderExportPlan {
  validateBundle(bundle, limits)
  const files = new Map<string, { openhome_id: string; bytes: Uint8Array<ArrayBuffer> }>()
  const byIdentity = new Map<string, FolderCopy[]>()
  const artifacts = new Map(bundle.artifacts.map((entry) => [entry.artifact.id, entry]))
  for (const record of bundle.pokemon) {
    const originals = record.original_artifact_ids.flatMap((id) => {
      const entry = artifacts.get(id)
      return entry && 'format' in entry.bytes && entry.bytes.format === 'ohpkm' ? [entry] : []
    })
    if (originals.length > 1)
      invalid('Multiple original OHPKM artifacts are ambiguous; use the lossless JSON bundle.')
    const chosen = originals[0] ?? artifacts.get(record.ohpkm_artifact_id)
    if (!chosen || !('format' in chosen.bytes) || chosen.bytes.format !== 'ohpkm')
      invalid('A record has no original or canonical OHPKM bytes for folder export.')
    const bytes = decodeBytes(chosen.bytes)
    const mon = readOhpkm(bytes)
    const identifier = mon.openhomeId
    mon.free()
    files.set(record.id, { openhome_id: identifier, bytes })
    const group = byIdentity.get(identifier) ?? []
    group.push({ pokemon_id: record.id, placement: placementOf(bundle, record.id) })
    byIdentity.set(identifier, group)
  }
  return {
    bundle,
    files,
    collisions: [...byIdentity].flatMap(([openhome_id, copies]) =>
      copies.length > 1 ? [{ openhome_id, copies }] : []
    ),
  }
}

export function buildFolderExport(
  plan: FolderExportPlan,
  choices: Readonly<Record<string, CopyChoice>> = {}
) {
  const collisions = new Map(plan.collisions.map((collision) => [collision.openhome_id, collision]))
  if (Object.keys(choices).some((key) => !collisions.has(key)))
    invalid('A choose-copy selection refers to an unknown identity collision.')
  for (const collision of plan.collisions) {
    const choice = choices[collision.openhome_id]
    if (!choice || !collision.copies.some((copy) => copy.pokemon_id === choice.pokemon_id))
      throw new RemoteError(
        'identity_collision',
        `OpenHome ID ${collision.openhome_id} represents server copies ${collision.copies.map((copy) => copy.pokemon_id).join(', ')}. Choose exactly one copy and one valid placement, or use the lossless bundle.`
      )
    parseWire('SlotAddress', choice.placement)
  }
  const content = structuredClone(plan.bundle.content)
  const omittedIds: string[] = []
  const selected = new Set<string>()
  for (const [id, file] of plan.files) {
    const choice = choices[file.openhome_id]
    if (!collisions.has(file.openhome_id) || choice?.pokemon_id === id) selected.add(id)
    else omittedIds.push(id)
  }
  for (const bank of content.banks)
    for (const box of bank.boxes)
      box.slots = box.slots.map((id) =>
        id && collisions.has(plan.files.get(id)?.openhome_id ?? '') ? null : id
      )
  for (const choice of Object.values(choices)) {
    const box = content.banks
      .find((bank) => bank.id === choice.placement.bank_id)
      ?.boxes.find((box) => box.id === choice.placement.box_id)
    if (!box || box.slots[choice.placement.slot] !== null)
      invalid('A choose-copy destination is unknown or occupied. No files were written.')
    box.slots[choice.placement.slot] = choice.pokemon_id
  }
  content.metadata = content.metadata.filter((entry) => selected.has(entry.pokemon_id))
  content.lookups = content.lookups.filter((entry) => selected.has(entry.pokemon_id))
  validateContent(content, selected)
  const identities = new IdentityMap()
  for (const id of selected) {
    const file = plan.files.get(id)
    if (!file) invalid('A selected Pokemon has no retained bytes.')
    identities.register(id, file.bytes)
  }
  const upstream: Record<string, Uint8Array<ArrayBuffer>> = {
    'storage/banks.json': jsonBytes(folderBanks(projectBanks(content, identities))),
    'storage/pokedex.json': jsonBytes(
      folderPokedex(content.openhome_compatibility?.pokedex_history ?? [])
    ),
  }
  const finalBundle = { ...plan.bundle, content }
  const identityMap: OpenHomeIdentityLink[] = []
  for (const id of selected) {
    const file = plan.files.get(id)
    if (!file) invalid('A selected Pokemon has no retained bytes.')
    upstream[`storage/mons_v2/${file.openhome_id}.ohpkm`] = new Uint8Array(file.bytes)
    identityMap.push({
      openhome_id: file.openhome_id,
      pokemon_id: id,
      placement: placementOf(finalBundle, id),
    })
  }
  const omittedPlacements = plan.bundle.pokemon.flatMap((record) => {
    const original = placementOf(plan.bundle, record.id)
    const final = selected.has(record.id) ? placementOf(finalBundle, record.id) : null
    return original && JSON.stringify(original) !== JSON.stringify(final)
      ? [{ pokemon_id: record.id, placement: original }]
      : []
  })
  return {
    files: upstream,
    manifest: {
      format: 'openhome-folder-identity-manifest' as const,
      version: 1 as const,
      source_revision: plan.bundle.source_revision,
      identity_map: identityMap,
      omitted_pokemon_ids: omittedIds,
      omitted_placements: omittedPlacements,
      lossless_companion: 'openhome-vault-bundle.json',
    },
  }
}

export function folderArchive(
  plan: FolderExportPlan,
  choices?: Readonly<Record<string, CopyChoice>>
) {
  const output = buildFolderExport(plan, choices)
  // Only generated allowlisted paths enter the ZIP writer. We never extract arbitrary ZIP input.
  return zipSync(
    {
      ...output.files,
      'openhome-identity-manifest.json': jsonBytes(output.manifest),
      'openhome-vault-bundle.json': jsonBytes(plan.bundle),
    },
    { level: 0 }
  )
}

export function remapIdentityManifest(
  links: readonly OpenHomeIdentityLink[],
  mappings: readonly IdMapping[]
): OpenHomeIdentityLink[] {
  function mapped(kind: IdMapping['kind'], id: string) {
    const match = mappings.find((entry) => entry.kind === kind && entry.source_id === id)
    if (!match) invalid('The server mapping omitted a folder identity reference.')
    return match.destination_id
  }
  return links.map((link) => ({
    openhome_id: link.openhome_id,
    pokemon_id: mapped('pokemon', link.pokemon_id),
    placement: link.placement
      ? {
          bank_id: mapped('bank', link.placement.bank_id),
          box_id: mapped('box', link.placement.box_id),
          slot: link.placement.slot,
        }
      : null,
  }))
}
