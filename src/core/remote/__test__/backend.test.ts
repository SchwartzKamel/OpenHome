// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteBackend } from '../backend'
import { sha256 } from '../crypto'
import { RemoteError } from '../errors'
import { readOhpkm } from '../identity'
import { parseWire } from '../validation'
import type * as Wire from '../wire-types'
import { BANK, BOX, HouseholdServer, id, POKEMON, record } from './support'

let server: HouseholdServer
let backend: RemoteBackend

beforeEach(async () => {
  server = new HouseholdServer()
  await server.start()
  backend = new RemoteBackend({ baseUrl: server.baseUrl, acknowledgeInsecureHttp: true })
  await backend.api.beginLogin('owner', 'long-unit-password').send()
})

afterEach(async () => {
  backend.dispose()
  await server.stop()
  vi.restoreAllMocks()
})

function value<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: string }): T {
  if (result.status === 'error') throw new Error(result.error)
  return result.data
}

const commits = () => server.requests.filter((request) => request.path === '/api/v1/vault/commit')
const favorite = (state: Wire.VaultContent) => ({
  ...state,
  metadata: state.metadata.map((entry) => ({ ...entry, favorite: true, tags: ['family'] })),
})

describe('real HTTP revisioned transactions', () => {
  it('does not resurrect a rolled-back buffer when an explicit rebase read finishes later', async () => {
    await backend.startTransaction()
    await backend.setTheme('dark')
    let release: (() => void) | undefined
    server.custom = async (request, response) => {
      if (request.path !== '/api/v1/vault') return false
      await new Promise<void>((ready) => {
        release = ready
      })
      server.json(response, 200, server.vault, server.vault.revision)
      return true
    }
    const rebasing = backend.rebaseTransaction((_current, staged) => staged)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await backend.rollbackTransaction()).toEqual({ status: 'ok', data: null })
    release?.()
    expect(await rebasing).toMatchObject({ status: 'error', failure: { code: 'cancelled' } })
    expect(backend.connection.editing).toBe(false)
    expect(commits()).toHaveLength(0)
  })

  it('cannot cache or return an old private read after switching credentials', async () => {
    // Logout/401 clearing must also defeat requests that were already in flight.
    let release: (() => void) | undefined
    let intercepted = false
    server.custom = async (request, response) => {
      if (request.path !== '/api/v1/vault' || intercepted) return false
      intercepted = true
      const old = structuredClone(server.vault)
      await new Promise<void>((ready) => {
        release = ready
      })
      server.json(response, 200, old, old.revision)
      return true
    }
    const reading = backend.getRecords()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    backend.api.clearCredentials()
    await backend.api.beginLogin('second', 'another-unit-password').send()
    release?.()
    expect(await reading).toMatchObject({ status: 'error', failure: { code: 'cancelled' } })
    expect(backend.connection).toMatchObject({
      coherent: false,
      revision: undefined,
      editing: false,
    })
    expect(backend.connection.lastError).toBeUndefined()
  })

  it('stages and rewinds locally, then sends one aggregate request with strong headers', async () => {
    // Saving several legacy state pieces must never turn into several independently committed writes.
    expect(await backend.startTransaction()).toEqual({ status: 'ok', data: null })
    const checkpoint = value(await backend.checkpoint())
    const original = value(await backend.getVault()).content
    expect(await backend.stageContent(favorite(original))).toEqual({ status: 'ok', data: null })
    expect(value(await backend.getVault()).content.metadata[0].favorite).toBe(true)
    expect(commits()).toHaveLength(0)
    expect(await backend.rewind(checkpoint)).toEqual({ status: 'ok', data: null })
    expect(value(await backend.getVault()).content.metadata[0].favorite).toBe(false)
    await backend.stageContent(favorite(original))
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(commits()).toHaveLength(1)
    const request = commits()[0]
    expect(request.headers.authorization).toBe(`Bearer ${server.bearer}`)
    expect(request.headers['if-match']).toBe('"vault-0"')
    expect(parseWire('Id', request.headers['idempotency-key'])).toBeTruthy()
    expect(request.headers['content-type']).toBe('application/json')
    const body = parseWire('VaultCommitRequest', request.body)
    expect(body.mode).toBe('replace')
    if (body.mode === 'replace')
      expect(body.state.metadata[0]).toMatchObject({ favorite: true, tags: ['family'] })
    expect(server.vault.revision).toBe(1)
    expect(value(await backend.getVault()).content.metadata[0].favorite).toBe(true)
    expect(backend.connection.editing).toBe(false)
  })

  it('rolls back without a mutation and cannot rewind into a different transaction', async () => {
    await backend.startTransaction()
    const checkpoint = value(await backend.checkpoint())
    const original = value(await backend.getVault()).content
    await backend.stageContent(favorite(original))
    expect(await backend.rollbackTransaction()).toEqual({ status: 'ok', data: null })
    expect(value(await backend.getVault()).content.metadata[0].favorite).toBe(false)
    await backend.startTransaction()
    expect(await backend.rewind(checkpoint)).toMatchObject({
      status: 'error',
      failure: { code: 'invalid_state' },
    })
    expect(commits()).toHaveLength(0)
  })

  it('keeps edits on stale revision, resyncs without overwriting them, and requires explicit rebase with a new key', async () => {
    await backend.startTransaction()
    await backend.stageContent(favorite(value(await backend.getVault()).content))
    server.vault.revision = 1
    server.vault.content.banks[0].name = 'Other client'
    const conflict = await backend.commitTransaction()
    expect(conflict).toMatchObject({
      status: 'error',
      failure: { code: 'stale_revision', httpStatus: 409 },
    })
    expect(value(await backend.getVault()).content.metadata[0].favorite).toBe(true)
    expect(await backend.resync()).toMatchObject({ status: 'ok', data: { revision: 1 } })
    expect(value(await backend.getVault()).revision).toBe(0)
    expect(backend.connection).toMatchObject({ editing: true, conflicted: true })
    expect(
      await backend.rebaseTransaction((current, staged) => ({
        ...current,
        metadata: staged.metadata,
      }))
    ).toEqual({ status: 'ok', data: null })
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(commits()).toHaveLength(2)
    expect(commits()[1].headers['if-match']).toBe('"vault-1"')
    expect(commits()[1].headers['idempotency-key']).not.toBe(
      commits()[0].headers['idempotency-key']
    )
    expect(server.vault.content.banks[0].name).toBe('Other client')
    expect(server.vault.content.metadata[0].favorite).toBe(true)
  })

  it('replays the exact key, body and If-Match after a lost response and refuses an unsafe rollback', async () => {
    // The test service actually commits, then destroys the response: a fresh-key retry would duplicate work.
    await backend.startTransaction()
    await backend.stageContent(favorite(value(await backend.getVault()).content))
    server.dropNextCommit = true
    expect(await backend.commitTransaction()).toMatchObject({
      status: 'error',
      failure: { code: 'network_error', uncertain: true },
    })
    expect(server.vault.revision).toBe(1)
    expect(await backend.rollbackTransaction()).toMatchObject({
      status: 'error',
      failure: { code: 'uncertain_commit' },
    })
    expect(
      await backend.stageCommands([{ op: 'pokemon_place', pokemon_id: POKEMON, destination: null }])
    ).toMatchObject({
      status: 'error',
      failure: { code: 'uncertain_commit' },
    })
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(commits()).toHaveLength(2)
    expect(commits()[0].text).toBe(commits()[1].text)
    expect(commits()[0].headers['idempotency-key']).toBe(commits()[1].headers['idempotency-key'])
    expect(commits()[1].headers['if-match']).toBe('"vault-0"')
    expect(server.vault.revision).toBe(1)
  })

  it('keeps staged edits on malformed success bodies and replays rather than assuming success', async () => {
    await backend.startTransaction()
    await backend.stageContent(favorite(value(await backend.getVault()).content))
    let malformed = true
    server.custom = (request, response) => {
      if (request.path !== '/api/v1/vault/commit' || !malformed) return false
      malformed = false
      response.writeHead(200, { 'Content-Type': 'application/json', ETag: '"vault-1"' })
      response.end('{"revision":1,"revision":2,"applied_commands":1}')
      return true
    }
    expect(await backend.commitTransaction()).toMatchObject({
      status: 'error',
      failure: { code: 'protocol_error', uncertain: true },
    })
    expect(value(await backend.getVault()).content.metadata[0].favorite).toBe(true)
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(commits()[0].text).toBe(commits()[1].text)
    expect(commits()[0].headers['idempotency-key']).toBe(commits()[1].headers['idempotency-key'])
  })

  it('executes closed placement and deletion deltas and never silently overwrites another slot', async () => {
    await backend.startTransaction()
    expect(
      await backend.stageCommands([
        {
          op: 'pokemon_place',
          pokemon_id: POKEMON,
          destination: { bank_id: BANK, box_id: BOX, slot: 1 },
        },
      ])
    ).toEqual({ status: 'ok', data: null })
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(server.vault.content.banks[0].boxes[0].slots.slice(0, 2)).toEqual([null, POKEMON])
    await backend.startTransaction()
    expect(await backend.deleteHomeMons([server.pokemon.identifier])).toEqual({
      status: 'ok',
      data: null,
    })
    expect(value(await backend.getOhpkmCount())).toBe(0)
    expect(value(await backend.getVault()).pokedex.species).toBe(0)
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(server.records).toHaveLength(0)
    expect(parseWire('VaultCommitRequest', commits()[1].body)).toEqual({
      mode: 'delta',
      commands: [{ op: 'pokemon_delete', pokemon_id: POKEMON }],
    })
  })

  it('does not lose concurrent staged commands or replace an already open transaction', async () => {
    await Promise.all([
      backend.stageCommands([
        { op: 'metadata_put', metadata: { pokemon_id: POKEMON, favorite: true, tags: [] } },
      ]),
      backend.stageCommands([{ op: 'pokemon_place', pokemon_id: POKEMON, destination: null }]),
    ])
    await backend.startTransaction()
    expect(await backend.startTransaction()).toMatchObject({
      status: 'error',
      failure: { code: 'invalid_state' },
    })
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    const body = parseWire('VaultCommitRequest', commits()[0].body)
    expect(body.mode === 'delta' && body.commands.length).toBe(2)
    expect(server.vault.content.metadata[0].favorite).toBe(true)
    expect(server.vault.content.banks[0].boxes[0].slots[0]).toBeNull()
  })

  it('restarts stale traversals instead of mixing Pokemon pages from different revisions', async () => {
    let traversals = 0
    server.custom = (request, response) => {
      if (request.path !== '/api/v1/pokemon' || traversals++) return false
      server.vault.revision++
      server.json(response, 409, {
        error: { code: 'stale_revision', message: 'Changed during traversal' },
      })
      return true
    }
    expect(value(await backend.resync()).revision).toBe(1)
    expect(server.requests.filter((request) => request.path === '/api/v1/vault')).toHaveLength(2)
    expect(
      server.requests
        .filter((request) => request.path === '/api/v1/pokemon')
        .map((request) => request.query.get('at_revision'))
    ).toEqual(['0', '1'])
  })

  it('clears private caches and staged edits on any 401, including an invalid JSON error response', async () => {
    const lookups = vi.fn()
    const dex = vi.fn()
    backend.registerListeners({ onLookupsUpdate: lookups, onPokedexUpdate: dex })
    await backend.startTransaction()
    await backend.loadHomeBanks()
    await backend.stageContent(favorite(value(await backend.getVault()).content))
    server.custom = (_request, response) => {
      response.writeHead(401, { 'Content-Type': 'text/html' })
      response.end('<html>session expired</html>')
      return true
    }
    expect(await backend.resync()).toMatchObject({
      status: 'error',
      failure: { code: 'unauthorized', httpStatus: 401 },
    })
    expect(backend.connection).toMatchObject({
      authenticated: false,
      coherent: false,
      editing: false,
      revision: undefined,
    })
    expect(await backend.lookupOhpkmById(server.pokemon.identifier)).toMatchObject({
      status: 'error',
      failure: { code: 'unauthorized' },
    })
    expect(lookups).toHaveBeenLastCalledWith({ gen12: {}, gen345: {} })
    expect(dex).toHaveBeenLastCalledWith({ byDexNumber: {} })
  })
})

describe('binary identity and strict capability boundaries', () => {
  it('prunes old UUID aliases after a restore resync and rollback, without inventing a same-ID copy collision', async () => {
    await backend.loadHomeBanks()
    await backend.startTransaction()
    await backend.setTheme('dark')
    const restored = id(300)
    server.records = [record(server.pokemon.observed, restored)]
    server.vault.content.metadata = [server.records[0].metadata]
    server.vault.content.banks[0].boxes[0].slots[0] = restored
    server.vault.revision++
    await backend.resync()
    await backend.rollbackTransaction()
    const banks = value(await backend.loadHomeBanks())
    expect(banks.banks[0].boxes.get(0)?.identifiers.get(0)).toBe(server.pokemon.identifier)
    const mon = value(await backend.lookupOhpkmById(server.pokemon.identifier))
    expect(mon?.openhomeId).toBe(server.pokemon.identifier)
    mon?.free()
  })

  it('maps server UUIDs to actual OHPKM getters and preserves the exact original PK8 backup', async () => {
    const banks = value(await backend.loadHomeBanks())
    const identifier = banks.banks[0].boxes.get(0)?.identifiers.get(0)
    expect(identifier).toBe(server.pokemon.identifier)
    expect(identifier).not.toBe(POKEMON)
    const mon = value(await backend.lookupOhpkmById(server.pokemon.identifier))
    expect(mon).toBeDefined()
    expect(mon?.openhomeId).toBe(identifier)
    expect(new Uint8Array(mon?.originalData?.data ?? [])).toEqual(server.pokemon.original)
    expect(sha256(new Uint8Array(mon?.originalData?.data ?? []))).toBe(
      sha256(server.pokemon.original)
    )
    mon?.free()
    const batch = value(
      await backend.lookupOhpkmBatch([server.pokemon.identifier, '0001-1234abcd-00000001'])
    )
    expect(batch.get(server.pokemon.identifier)?.status).toBe('ok')
    expect(batch.get('0001-1234abcd-00000001')).toEqual({
      status: 'error',
      error: { identifier: '0001-1234abcd-00000001' },
    })
    for (const result of batch.values()) if (result.status === 'ok') result.data.free()
    expect(server.requests.find((request) => request.path.endsWith('/export'))).toMatchObject({
      method: 'POST',
      text: '{"representation":"ohpkm"}',
    })
  })

  it('translates real bank Maps back to 30-slot UUID arrays, rejecting 120-slot truncation', async () => {
    const banks = value(await backend.loadHomeBanks())
    const box = banks.banks[0].boxes.get(0)
    if (!box) throw new Error('Missing fixture box')
    box.identifiers.delete(0)
    box.identifiers.set(1, server.pokemon.identifier)
    await backend.startTransaction()
    expect(await backend.writeHomeBanks(banks)).toEqual({ status: 'ok', data: null })
    expect(commits()).toHaveLength(0)
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(server.vault.content.banks[0].boxes[0].slots).toHaveLength(30)
    expect(server.vault.content.banks[0].boxes[0].slots.slice(0, 2)).toEqual([null, POKEMON])
    box.identifiers.set(119, server.pokemon.identifier)
    expect(await backend.writeHomeBanks(banks)).toMatchObject({
      status: 'error',
      failure: { code: 'unavailable' },
    })
    expect(commits()).toHaveLength(1)
  })

  it('fails visibly for same-embedded-ID copies without collapsing either server UUID', async () => {
    server.records.push(record(server.pokemon.observed, id(30)))
    server.vault.pokemon_count++
    server.vault.content.metadata.push(server.records[1].metadata)
    server.vault.content.banks[0].boxes[0].slots[1] = id(30)
    const banks = await backend.loadHomeBanks()
    expect(banks).toMatchObject({ status: 'error', failure: { code: 'identity_collision' } })
    expect(banks.status === 'error' && banks.error).toContain(POKEMON)
    expect(banks.status === 'error' && banks.error).toContain(id(30))
    expect(value(await backend.getRecords())).toHaveLength(2)
    expect(server.records).toHaveLength(2)
  })

  it('rejects fallback identities rather than regenerating a plausible original', () => {
    const bytes = new Uint8Array(server.pokemon.binary)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < view.getUint16(6, true); index++) {
      const start = 8 + index * 6
      if (view.getUint16(start, true) === 0) {
        const main = view.getUint16(start + 2, true)
        bytes.fill(0, main + 250, main + 260)
      }
    }
    expect(() => readOhpkm(bytes)).toThrow('no reliable stored V2 OpenHome identity')
  })

  it('returns typed visible errors for plugins, native IPC, immutable-byte edits and incompatible local strategies', async () => {
    const requestsBefore = server.requests.length
    for (const result of await Promise.all([
      backend.listInstalledPlugins(),
      backend.downloadPlugin('https://invalid.example/plugin.js'),
      backend.loadPluginCode('arbitrary'),
      backend.getDataDirPath(),
      backend.addToOhpkmStore({}),
      backend.addToLookups({ gen12: {}, gen345: {} }),
      backend.getConvertStrategies(),
    ])) {
      expect(result).toMatchObject({ status: 'error', failure: { code: 'unavailable' } })
    }
    await expect(backend.loadItemBag()).rejects.toBeInstanceOf(RemoteError)
    expect(server.requests).toHaveLength(requestsBefore)
    expect(backend.capabilities).toMatchObject({
      plugins: false,
      arbitraryServerFiles: false,
      vaultSlotsPerBox: 30,
    })
  })

  it('keeps local file writers out of a server transaction', async () => {
    await backend.startTransaction()
    expect(await backend.writeSaveFile('/client/only.sav', new Uint8Array([1]))).toMatchObject({
      status: 'error',
      failure: { code: 'unavailable' },
    })
    expect(server.requests.every((request) => !request.text.includes('/client/only.sav'))).toBe(
      true
    )
  })

  it('supports exact legacy filters and reports unrepresentable ones instead of returning empty success', async () => {
    const result = await backend.searchOhpkmStore({ pageIndex: 0, pageSize: 10 }, [
      { nationalDex: server.pokemon.observed.species },
    ])
    expect(value(result).results).toHaveLength(1)
    value(result).results.forEach((mon) => mon.free())
    expect(
      await backend.searchOhpkmStore({ pageIndex: 0, pageSize: 10 }, [
        { moveTextPrefixEng: 'flame' },
      ])
    ).toMatchObject({
      status: 'error',
      failure: { code: 'unavailable' },
    })
  })
})
