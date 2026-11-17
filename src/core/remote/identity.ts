import { OHPKM } from '@openhome-core/pkm/OHPKM'
import type { StoredBankData } from '@openhome-core/save/util/storage'
import { RemoteError } from './errors'
import { parseWire } from './validation'
import type * as Wire from './wire-types'

export function readOhpkm(bytes: Uint8Array): OHPKM {
  const owned = new Uint8Array(bytes)
  let mon: OHPKM
  try {
    mon = OHPKM.fromBytes(owned.buffer)
  } catch {
    throw new RemoteError('invalid_bytes', 'The server did not return a readable binary OHPKM')
  }
  try {
    const view = new DataView(owned.buffer)
    if (owned.length < 8 || view.getUint16(4, true) !== 2) throw new Error('version')
    const sections = view.getUint16(6, true)
    if (8 + sections * 6 >= owned.length) throw new Error('sections')
    let identity: string | undefined
    for (let index = 0; index < sections; index++) {
      const metadata = 8 + index * 6
      if (view.getUint16(metadata, true) !== 0) continue
      if (identity) throw new Error('duplicate main section')
      const start = view.getUint16(metadata + 2, true)
      const length = view.getUint16(metadata + 4, true)
      if (start < 8 + sections * 6 || length < 305 || start + length > owned.length) {
        throw new Error('main section')
      }
      // Pinned MainDataV2 stores its identity at 250..260. Zero components trigger
      // an upstream fallback; accepting that fallback would invent an export identity.
      const dex = view.getUint16(start + 250, true)
      const tid = view.getUint16(start + 252, true)
      const sid = view.getUint16(start + 254, true)
      const pid = view.getUint32(start + 256, true)
      if (!dex || !tid || !sid || !pid) throw new Error('fallback identity')
      identity = `${dex.toString().padStart(4, '0')}-${tid.toString(16).padStart(4, '0')}${sid.toString(16).padStart(4, '0')}-${pid.toString(16).padStart(8, '0')}`
    }
    if (!identity || parseWire('OpenHomeId', mon.openhomeId) !== identity) {
      throw new Error('unreliable identity')
    }
    return mon
  } catch {
    mon.free()
    throw new RemoteError(
      'invalid_bytes',
      'OHPKM has no reliable stored V2 OpenHome identity; its bytes were not modified'
    )
  }
}

export class IdentityMap {
  private readonly byServer = new Map<
    string,
    { identifier: string; bytes: Uint8Array<ArrayBuffer> }
  >()
  private readonly byOpenhome = new Map<string, Set<string>>()

  register(serverId: string, bytes: Uint8Array): void {
    parseWire('Id', serverId)
    const mon = readOhpkm(bytes)
    const identifier = mon.openhomeId
    mon.free()
    this.remove(serverId)
    this.byServer.set(serverId, { identifier, bytes: new Uint8Array(bytes) })
    const ids = this.byOpenhome.get(identifier) ?? new Set<string>()
    ids.add(serverId)
    this.byOpenhome.set(identifier, ids)
  }

  remove(serverId: string): void {
    const previous = this.byServer.get(serverId)
    if (previous) {
      const ids = this.byOpenhome.get(previous.identifier)
      ids?.delete(serverId)
      if (!ids?.size) this.byOpenhome.delete(previous.identifier)
    }
    this.byServer.delete(serverId)
  }

  clear(): void {
    this.byServer.clear()
    this.byOpenhome.clear()
  }

  has(serverId: string): boolean {
    return this.byServer.has(serverId)
  }

  identifier(serverId: string): string {
    const entry = this.byServer.get(serverId)
    if (!entry)
      throw new RemoteError('not_found', `No decoded OHPKM for server Pokemon ${serverId}`)
    this.serverId(entry.identifier)
    return entry.identifier
  }

  serverId(identifier: string): string {
    const ids = this.byOpenhome.get(parseWire('OpenHomeId', identifier))
    if (!ids?.size)
      throw new RemoteError('not_found', `No server Pokemon for OpenHome ID ${identifier}`)
    if (ids.size !== 1) {
      throw new RemoteError(
        'identity_collision',
        `OpenHome ID ${identifier} represents multiple server copies: ${[...ids].join(', ')}. Use the lossless server view/bundle or explicitly select a copy; no copy was collapsed.`
      )
    }
    return [...ids][0]
  }

  mon(serverId: string): OHPKM {
    const entry = this.byServer.get(serverId)
    if (!entry) throw new RemoteError('not_found', 'No decoded binary OHPKM is cached')
    return readOhpkm(entry.bytes)
  }

  bytes(serverId: string): Uint8Array<ArrayBuffer> {
    const entry = this.byServer.get(serverId)
    if (!entry) throw new RemoteError('not_found', 'No decoded binary OHPKM is cached')
    return new Uint8Array(entry.bytes)
  }
}

function sourceName(
  current: string,
  original: Wire.OpenHomeSourceName | undefined,
  fallback: string
) {
  return original !== undefined && current === (original || fallback) ? original : current
}

export function projectBanks(content: Wire.VaultContent, identities: IdentityMap): StoredBankData {
  return {
    current_bank: content.openhome_compatibility?.current_bank ?? 0,
    banks: content.banks.map((bank, bankIndex) => {
      const link = content.openhome_compatibility?.banks.find((entry) => entry.bank_id === bank.id)
      return {
        id: link?.folder_id ?? bank.id,
        index: bankIndex,
        name: sourceName(bank.name, link?.source_name, `Bank ${bankIndex + 1}`),
        current_box: link?.current_box ?? 0,
        boxes: new Map(
          bank.boxes.map((box, boxIndex) => {
            const boxLink = link?.boxes.find((entry) => entry.box_id === box.id)
            return [
              boxIndex,
              {
                id: boxLink?.folder_id ?? box.id,
                index: boxIndex,
                name: sourceName(box.name, boxLink?.source_name, `Box ${boxIndex + 1}`),
                identifiers: new Map(
                  box.slots.flatMap((id, slot) =>
                    id ? [[slot, identities.identifier(id)] as const] : []
                  )
                ),
              },
            ] as const
          })
        ),
      }
    }),
  }
}

export function translateBanks(
  stored: StoredBankData,
  current: Wire.VaultContent,
  identities: IdentityMap
): Pick<Wire.VaultContent, 'banks' | 'openhome_compatibility'> {
  if (!Number.isInteger(stored.current_bank) || !stored.banks[stored.current_bank]) {
    throw new RemoteError('invalid_request', 'Current bank is outside the layout')
  }
  const ids = new Set<string>()
  const placements = new Set<string>()
  const links: Wire.OpenHomeBankLink[] = []
  function uniqueId(id: string) {
    parseWire('Id', id)
    if (ids.has(id)) throw new RemoteError('invalid_request', 'Bank/box folder IDs must be unique')
    ids.add(id)
  }
  const banks = stored.banks.map((bank, bankIndex) => {
    uniqueId(bank.id)
    if (bank.index !== bankIndex || !bank.boxes.has(bank.current_box)) {
      throw new RemoteError('invalid_request', 'Bank indices and current box must match the layout')
    }
    const previous = current.openhome_compatibility?.banks.find(
      (link) => link.folder_id === bank.id
    )
    const bankId = previous?.bank_id ?? bank.id
    const boxLinks: Wire.OpenHomeBoxLink[] = []
    const boxes = [...bank.boxes.entries()].map(([key, box], boxIndex) => {
      uniqueId(box.id)
      if (key !== boxIndex || box.index !== boxIndex) {
        throw new RemoteError(
          'invalid_request',
          'Box indices must be consecutive and match their Map keys'
        )
      }
      const boxId = previous?.boxes.find((link) => link.folder_id === box.id)?.box_id ?? box.id
      const slots: (string | null)[] = Array.from({ length: 30 }, () => null)
      for (const [slot, identifier] of box.identifiers) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= 30) {
          throw new RemoteError(
            'unavailable',
            'Household boxes have exactly 30 slots; desktop slots 30–119 cannot be truncated'
          )
        }
        const id = identities.serverId(identifier)
        if (placements.has(id))
          throw new RemoteError('resource_conflict', 'A Pokemon cannot occupy two slots')
        placements.add(id)
        slots[slot] = id
      }
      boxLinks.push({ box_id: boxId, folder_id: box.id, index: boxIndex, source_name: box.name })
      return { id: boxId, name: box.name || `Box ${boxIndex + 1}`, slots }
    })
    links.push({
      bank_id: bankId,
      folder_id: bank.id,
      index: bankIndex,
      source_name: bank.name,
      current_box: bank.current_box,
      boxes: boxLinks,
    })
    return { id: bankId, name: bank.name || `Bank ${bankIndex + 1}`, boxes }
  })
  const candidate = parseWire('VaultContent', {
    ...current,
    banks,
    openhome_compatibility: {
      version: 1,
      current_bank: stored.current_bank,
      banks: links,
      pokedex_history: current.openhome_compatibility?.pokedex_history ?? [],
    },
  })
  return { banks: candidate.banks, openhome_compatibility: candidate.openhome_compatibility }
}
