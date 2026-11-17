import { RemoteError } from './errors'
import { parseWire } from './validation'
import type * as Wire from './wire-types'
import { OriginGames } from '@pkm-rs/pkg'

export interface CollectionSnapshot {
  readonly generation: number
  vault: Wire.VaultState
  records: Map<string, Wire.PokemonRecord>
}

export function trackerCounts(records: Iterable<Wire.PokemonRecord>): Wire.TrackerCounts {
  const species = new Set<number>()
  const forms = new Set<string>()
  const moves = new Set<number>()
  const abilities = new Set<number>()
  const ribbons = new Set<number>()
  for (const { observed } of records) {
    species.add(observed.species)
    forms.add(`${observed.species}:${observed.form}`)
    observed.moves.forEach((move) => moves.add(move))
    if (observed.ability !== null) abilities.add(observed.ability)
    observed.ribbons.forEach((ribbon) => ribbons.add(ribbon))
  }
  return {
    species: species.size,
    forms: forms.size,
    moves: moves.size,
    abilities: abilities.size,
    ribbons: ribbons.size,
  }
}

export function compatibility(content: Wire.VaultContent): Wire.OpenHomeCompatibility {
  const previous = content.openhome_compatibility
  return {
    version: 1,
    current_bank: Math.min(previous?.current_bank ?? 0, content.banks.length - 1),
    pokedex_history: structuredClone(previous?.pokedex_history ?? []),
    banks: content.banks.map((bank, bankIndex) => {
      const link = previous?.banks.find((entry) => entry.bank_id === bank.id)
      return {
        bank_id: bank.id,
        folder_id: link?.folder_id ?? bank.id,
        index: bankIndex,
        source_name: link ? link.source_name : bank.name,
        current_box: Math.min(link?.current_box ?? 0, bank.boxes.length - 1),
        boxes: bank.boxes.map((box, boxIndex) => ({
          box_id: box.id,
          folder_id: link?.boxes.find((entry) => entry.box_id === box.id)?.folder_id ?? box.id,
          index: boxIndex,
          source_name: (() => {
            const previousBox = link?.boxes.find((entry) => entry.box_id === box.id)
            return previousBox ? previousBox.source_name : box.name
          })(),
        })),
      }
    }),
  }
}

export function validateContent(content: Wire.VaultContent, activeIds: ReadonlySet<string>): void {
  parseWire('VaultContent', content)
  const ids = new Set<string>()
  const placed = new Set<string>()
  const unique = (id: string) => {
    if (ids.has(id)) throw new RemoteError('resource_conflict', 'Bank/box IDs must be unique')
    ids.add(id)
  }
  for (const bank of content.banks) {
    unique(bank.id)
    for (const box of bank.boxes) {
      unique(box.id)
      for (const id of box.slots) {
        if (!id) continue
        if (!activeIds.has(id))
          throw new RemoteError('not_found', 'A slot refers to an inactive Pokemon')
        if (placed.has(id))
          throw new RemoteError('resource_conflict', 'A Pokemon cannot occupy two slots')
        placed.add(id)
      }
    }
  }
  const metadata = new Set<string>()
  for (const entry of content.metadata) {
    if (!activeIds.has(entry.pokemon_id) || metadata.has(entry.pokemon_id)) {
      throw new RemoteError(
        'resource_conflict',
        'Metadata must identify each active Pokemon exactly once'
      )
    }
    metadata.add(entry.pokemon_id)
  }
  if (metadata.size !== activeIds.size) {
    throw new RemoteError('resource_conflict', 'An active Pokemon has no metadata')
  }
  if (new Set(content.metadata.flatMap((entry) => entry.tags)).size > 128) {
    throw new RemoteError('limit_exceeded', 'A vault can contain at most 128 distinct tags')
  }
  const digests = new Set<string>()
  for (const entry of content.lookups) {
    if (!activeIds.has(entry.pokemon_id) || digests.has(entry.source_sha256)) {
      throw new RemoteError('resource_conflict', 'Lookups must uniquely reference active Pokemon')
    }
    digests.add(entry.source_sha256)
  }
  const strategies = new Set(content.conversion_strategies.map((entry) => entry.id))
  if (
    strategies.size !== content.conversion_strategies.length ||
    (content.settings.default_strategy_id && !strategies.has(content.settings.default_strategy_id))
  ) {
    throw new RemoteError(
      'resource_conflict',
      'Conversion strategies have duplicate or dangling IDs'
    )
  }
  const layout = content.openhome_compatibility
  if (layout) {
    const history = new Set<string>()
    for (const entry of layout.pokedex_history) {
      const key = `${entry.species}:${entry.form}`
      if (history.has(key) || !entry.games.every((game) => OriginGames.isOriginGameString(game))) {
        throw new RemoteError(
          'invalid_request',
          'Historical Pokedex entries require unique forms and actual pinned OriginGame variants'
        )
      }
      history.add(key)
    }
    if (
      layout.current_bank >= content.banks.length ||
      layout.banks.length !== content.banks.length
    ) {
      throw new RemoteError('resource_conflict', 'Folder compatibility does not match the banks')
    }
    const folders = new Set<string>()
    layout.banks.forEach((link, index) => {
      const bank = content.banks[index]
      if (
        link.bank_id !== bank.id ||
        link.index !== index ||
        link.current_box >= bank.boxes.length ||
        link.boxes.length !== bank.boxes.length
      ) {
        throw new RemoteError('resource_conflict', 'Folder bank links do not match the layout')
      }
      for (const folder of [link.folder_id, ...link.boxes.map((box) => box.folder_id)]) {
        if (folders.has(folder))
          throw new RemoteError('resource_conflict', 'Folder UUIDs must be unique')
        folders.add(folder)
      }
      link.boxes.forEach((box, boxIndex) => {
        if (box.index !== boxIndex || box.box_id !== bank.boxes[boxIndex].id) {
          throw new RemoteError('resource_conflict', 'Folder box links do not match the layout')
        }
      })
    })
  }
}

export function applyCommands(
  original: Wire.VaultContent,
  commands: Wire.VaultCommand[],
  activeIds: Set<string>
): Wire.VaultContent {
  const content = structuredClone(original)
  const findBank = (id: string) => {
    const bank = content.banks.find((entry) => entry.id === id)
    if (!bank) throw new RemoteError('not_found', 'Bank not found in the edit buffer')
    return bank
  }
  const requirePokemon = (id: string) => {
    if (!activeIds.has(id))
      throw new RemoteError('not_found', 'Pokemon not found in the edit buffer')
  }
  const unlink = (id: string) => {
    for (const bank of content.banks) {
      for (const box of bank.boxes) box.slots = box.slots.map((slot) => (slot === id ? null : slot))
    }
  }
  for (const command of commands) {
    switch (command.op) {
      case 'bank_put': {
        const index = content.banks.findIndex((bank) => bank.id === command.bank.id)
        if (index < 0) content.banks.push(structuredClone(command.bank))
        else content.banks[index] = structuredClone(command.bank)
        break
      }
      case 'bank_delete': {
        const bank = findBank(command.bank_id)
        if (content.banks.length === 1 || bank.boxes.some((box) => box.slots.some(Boolean))) {
          throw new RemoteError('resource_conflict', 'Cannot delete a nonempty or last bank')
        }
        content.banks = content.banks.filter((entry) => entry.id !== bank.id)
        break
      }
      case 'box_put': {
        const bank = findBank(command.bank_id)
        const index = bank.boxes.findIndex((box) => box.id === command.box.id)
        if (index < 0) bank.boxes.push(structuredClone(command.box))
        else bank.boxes[index] = structuredClone(command.box)
        break
      }
      case 'box_delete': {
        const bank = findBank(command.bank_id)
        const box = bank.boxes.find((entry) => entry.id === command.box_id)
        if (!box) throw new RemoteError('not_found', 'Box not found in the edit buffer')
        if (bank.boxes.length === 1 || box.slots.some(Boolean)) {
          throw new RemoteError('resource_conflict', 'Cannot delete a nonempty or last box')
        }
        bank.boxes = bank.boxes.filter((entry) => entry.id !== box.id)
        break
      }
      case 'pokemon_place': {
        requirePokemon(command.pokemon_id)
        unlink(command.pokemon_id)
        if (command.destination) {
          const box = findBank(command.destination.bank_id).boxes.find(
            (entry) => entry.id === command.destination?.box_id
          )
          if (!box) throw new RemoteError('not_found', 'Destination box not found')
          if (box.slots[command.destination.slot]) {
            throw new RemoteError(
              'resource_conflict',
              'Destination slot is occupied; unplace both copies before swapping'
            )
          }
          box.slots[command.destination.slot] = command.pokemon_id
        }
        break
      }
      case 'pokemon_delete':
        requirePokemon(command.pokemon_id)
        unlink(command.pokemon_id)
        activeIds.delete(command.pokemon_id)
        content.metadata = content.metadata.filter(
          (entry) => entry.pokemon_id !== command.pokemon_id
        )
        content.lookups = content.lookups.filter((entry) => entry.pokemon_id !== command.pokemon_id)
        break
      case 'metadata_put': {
        requirePokemon(command.metadata.pokemon_id)
        content.metadata = content.metadata.filter(
          (entry) => entry.pokemon_id !== command.metadata.pokemon_id
        )
        content.metadata.push(structuredClone(command.metadata))
        break
      }
      case 'settings_put':
        content.settings = structuredClone(command.settings)
        break
      case 'lookup_put':
        requirePokemon(command.entry.pokemon_id)
        content.lookups = content.lookups.filter(
          (entry) => entry.source_sha256 !== command.entry.source_sha256
        )
        content.lookups.push(structuredClone(command.entry))
        break
      case 'lookup_delete':
        content.lookups = content.lookups.filter(
          (entry) => entry.source_sha256 !== command.source_sha256
        )
        break
      case 'strategy_put':
        content.conversion_strategies = content.conversion_strategies.filter(
          (entry) => entry.id !== command.strategy.id
        )
        content.conversion_strategies.push(structuredClone(command.strategy))
        break
      case 'strategy_delete':
        content.conversion_strategies = content.conversion_strategies.filter(
          (entry) => entry.id !== command.strategy_id
        )
        break
    }
  }
  if (content.openhome_compatibility) content.openhome_compatibility = compatibility(content)
  validateContent(content, activeIds)
  return content
}
