import { RemoteError, parseWire } from '@openhome-core/remote'
import type {
  Bank,
  Box,
  PokemonRecord,
  Reservation,
  SaveSlot,
  SlotAddress,
  VaultContent,
} from '@openhome-core/remote'

export function placement(content: VaultContent, pokemonId: string): SlotAddress | null {
  for (const bank of content.banks) {
    for (const box of bank.boxes) {
      const slot = box.slots.indexOf(pokemonId)
      if (slot >= 0) return { bank_id: bank.id, box_id: box.id, slot }
    }
  }
  return null
}

export function reserved(
  reservations: Reservation[],
  pokemonId?: string,
  address?: SlotAddress
): boolean {
  return reservations.some(({ resource }) =>
    'pokemon_id' in resource
      ? resource.pokemon_id === pokemonId
      : !!address &&
        resource.bank_id === address.bank_id &&
        resource.box_id === address.box_id &&
        resource.slot === address.slot
  )
}

export function saveSlotKey(slot: SaveSlot): string {
  return slot.kind === 'box' ? `box-${slot.box}-${slot.slot}` : `party-${slot.slot}`
}

export function saveSlotLabel(slot: SaveSlot): string {
  return slot.kind === 'box'
    ? `Box ${slot.box + 1}, slot ${slot.slot + 1}`
    : `Party slot ${slot.slot + 1}`
}

export function vaultTag(revision: number) {
  return parseWire('VaultETag', `"vault-${revision}"`)
}

function same<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeValue<T>(base: T, current: T, staged: T, label: string): T {
  if (same(base, staged)) return structuredClone(current)
  if (same(base, current) || same(current, staged)) return structuredClone(staged)
  throw new RemoteError(
    'resource_conflict',
    `Rebase stopped: ${label} changed on both clients. Roll back and restage against the current vault.`
  )
}

function mergeItems<T extends { id: string }>(
  base: T[],
  current: T[],
  staged: T[],
  merge: (base: T, current: T, staged: T) => T
): T[] {
  const result: T[] = []
  for (const now of current) {
    const before = base.find((item) => item.id === now.id)
    const after = staged.find((item) => item.id === now.id)
    if (!before) {
      if (after && !same(now, after))
        throw new RemoteError(
          'resource_conflict',
          'A newly created ID already exists on the server'
        )
      result.push(structuredClone(now))
    } else if (after) {
      result.push(merge(before, now, after))
    } else if (!same(before, now)) {
      throw new RemoteError(
        'resource_conflict',
        'An item deleted locally was changed on the server'
      )
    }
  }
  for (const after of staged) {
    if (current.some((item) => item.id === after.id)) continue
    const before = base.find((item) => item.id === after.id)
    if (!before) result.push(structuredClone(after))
    else if (!same(before, after))
      throw new RemoteError('resource_conflict', 'An item edited locally was deleted on the server')
  }
  return result
}

function mergeBox(base: Box, current: Box, staged: Box): Box {
  return {
    id: current.id,
    name: mergeValue(base.name, current.name, staged.name, 'box name'),
    slots: current.slots.map((id, index) =>
      mergeValue(base.slots[index], id, staged.slots[index], `slot ${index + 1}`)
    ),
  }
}

function mergeBank(base: Bank, current: Bank, staged: Bank): Bank {
  return {
    id: current.id,
    name: mergeValue(base.name, current.name, staged.name, 'bank name'),
    boxes: mergeItems(base.boxes, current.boxes, staged.boxes, mergeBox),
  }
}

// Three-way reconciliation preserves unrelated remote changes; contested fields
// fail closed instead of treating explicit rebase as permission to overwrite them.
export function rebaseContent(
  base: VaultContent,
  current: VaultContent,
  staged: VaultContent
): VaultContent {
  const result: VaultContent = {
    ...structuredClone(current),
    banks: mergeItems(base.banks, current.banks, staged.banks, mergeBank),
    metadata: current.metadata.map((metadata) => {
      const before = base.metadata.find((entry) => entry.pokemon_id === metadata.pokemon_id)
      const after = staged.metadata.find((entry) => entry.pokemon_id === metadata.pokemon_id)
      if (!before || !after) return structuredClone(metadata)
      return {
        pokemon_id: metadata.pokemon_id,
        favorite: mergeValue(before.favorite, metadata.favorite, after.favorite, 'favorite'),
        tags: mergeValue(before.tags, metadata.tags, after.tags, 'labels'),
      }
    }),
  }
  for (const before of base.metadata) {
    const after = staged.metadata.find((entry) => entry.pokemon_id === before.pokemon_id)
    if (!after)
      throw new RemoteError(
        'unavailable',
        'Record deletion must be rolled back and deliberately restaged'
      )
    if (
      !current.metadata.some((entry) => entry.pokemon_id === before.pokemon_id) &&
      (!same(before, after) ||
        !same(placement(base, before.pokemon_id), placement(staged, before.pokemon_id)))
    ) {
      throw new RemoteError('resource_conflict', 'A locally edited Pokémon left this vault')
    }
  }
  const placed = new Set<string>()
  for (const bank of result.banks) {
    for (const box of bank.boxes) {
      for (const id of box.slots) {
        if (!id) continue
        if (placed.has(id))
          throw new RemoteError(
            'resource_conflict',
            'Concurrent placements conflict; no duplicate was staged'
          )
        placed.add(id)
      }
    }
  }
  if (current.openhome_compatibility) {
    const old = current.openhome_compatibility
    result.openhome_compatibility = {
      ...structuredClone(old),
      current_bank: Math.min(old.current_bank, result.banks.length - 1),
      banks: result.banks.map((bank, index) => {
        const previous = old.banks.find((entry) => entry.bank_id === bank.id)
        return {
          bank_id: bank.id,
          folder_id: previous?.folder_id ?? bank.id,
          index,
          source_name: previous ? previous.source_name : bank.name,
          current_box: Math.min(previous?.current_box ?? 0, bank.boxes.length - 1),
          boxes: bank.boxes.map((box, boxIndex) => {
            const link = previous?.boxes.find((entry) => entry.box_id === box.id)
            return {
              box_id: box.id,
              folder_id: link?.folder_id ?? box.id,
              index: boxIndex,
              source_name: link ? link.source_name : box.name,
            }
          }),
        }
      }),
    }
  }
  return parseWire('VaultContent', result)
}

export function collectionById(records: PokemonRecord[]) {
  return new Map(records.map((record) => [record.id, record]))
}
