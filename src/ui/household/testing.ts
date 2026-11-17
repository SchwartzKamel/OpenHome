import { bytesToPKM } from '@openhome-core/pkm/FileImport'
import { OHPKM } from '@openhome-core/pkm/OHPKM'
import {
  ARTIFACT,
  HouseholdServer,
  id,
  ORIGINAL,
  POKEMON,
  record,
  status as adapterStatus,
  USER,
  type CapturedRequest,
} from '@openhome-core/remote/__test__/support'
import { RemoteBackend } from '@openhome-core/remote'
import { encodeBase64, sha256 } from '@openhome-core/remote/crypto'
import { trackerCounts } from '@openhome-core/remote/state'
import { parseWire } from '@openhome-core/remote/validation'
import type * as Wire from '@openhome-core/remote/wire-types'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { act, fireEvent, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

export async function clickReady(element: HTMLElement) {
  await waitFor(() => expect(element).toBeEnabled())
  await act(async () => {
    fireEvent.click(element)
  })
}

// Typed HTTP fixture plus real binary OHPKM/WASM. Not the Rust service or a
// certification of the save-engine/native boundary.
export class WorkspaceFixture extends HouseholdServer {
  backend?: RemoteBackend
  readonly original: Wire.PkmBytes = {
    data_base64: encodeBase64(this.pokemon.original),
    sha256: sha256(this.pokemon.original),
    byte_length: this.pokemon.original.length,
    format: 'pk8',
  }
  readonly save = new Uint8Array(
    readFileSync(resolve('src/core/save/__test__/save-files/black.sav'))
  )
  readonly gen5 = this.realGen5()
  readonly pageCursor = 'cGFnZTI'
  readonly tradeId = id(80)
  readonly otherUser = id(81)
  readonly foreignPokemon = id(82)
  readonly joinCode = 'ABCDEFGHJK23'
  trade: Wire.Trade = {
    id: this.tradeId,
    revision: 0,
    offer_version: 0,
    state: 'WAITING',
    participants: [
      {
        user: { id: USER, username: 'owner', role: 'admin' },
        offer: [],
        confirmed_offer_version: null,
      },
    ],
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    outcome: null,
  }
  transfer?: Wire.TransferView
  preparedSave?: Wire.SaveBytes
  copyCount = 0
  dropNextImport = false
  dropNextTradeAction = false
  conversionAttempts: Wire.PokemonExportRequest[] = []
  private nextCopyId = 100
  private readonly copies = new Map<string, { text: string; output: Wire.PokemonImportResult }>()
  private readonly tradeReceipts = new Map<string, { text: string; output: Wire.TradeView }>()

  constructor() {
    super()
    this.custom = (request, response) => this.routes(request, response)
  }

  async login() {
    await this.start()
    this.backend = new RemoteBackend({ baseUrl: this.baseUrl, acknowledgeInsecureHttp: true })
    await this.backend.api.beginLogin('owner', 'long-unit-password').send()
    return this.backend
  }

  async close() {
    this.backend?.dispose()
    await this.stop()
  }

  private realGen5() {
    const original = new Uint8Array(readFileSync(resolve('test-files/pkm-files/pk5/Ditto.pkm')))
    const source = bytesToPKM(original, 'PK5')
    const mon = OHPKM.fromMonUnknownSave(source)
    source.free?.()
    const binary = new Uint8Array(mon.toByteArray())
    const observed: Wire.ObservedPokemon = {
      species: mon.nationalDex,
      form: mon.formIndex,
      nickname: mon.nickname,
      level: mon.getLevel(),
      shiny: mon.isShiny(),
      moves: [...new Set(mon.moves.filter((move) => move > 0))],
      ability: null,
      ribbons: [],
      source_generation: 5,
    }
    mon.free()
    return {
      original: {
        data_base64: encodeBase64(original),
        sha256: sha256(original),
        byte_length: original.length,
        format: 'pk5',
      } satisfies Wire.PkmBytes,
      ohpkm: {
        data_base64: encodeBase64(binary),
        sha256: sha256(binary),
        byte_length: binary.length,
        format: 'ohpkm',
      } satisfies Wire.OhpkmBytes,
      observed,
    }
  }

  originalArtifact(pokemonId = POKEMON): Wire.ArtifactSummary {
    return {
      id:
        pokemonId === POKEMON
          ? ORIGINAL
          : (this.records.find((item) => item.id === pokemonId)?.original_artifact_ids[0] ??
            ORIGINAL),
      sha256: this.original.sha256,
      byte_length: this.original.byte_length,
      kind: 'original_pkm',
      format: 'pk8',
      created_at: '2026-11-17T10:00:00Z',
    }
  }

  private respondTrade(
    response: ServerResponse,
    code: number,
    output: Wire.TradeView | Wire.TradeCreated
  ) {
    response.setHeader('ETag', `"trade-${output.trade.revision}"`)
    this.json(response, code, output)
  }

  private copy(request: CapturedRequest, response: ServerResponse) {
    const key = parseWire('Id', request.headers['idempotency-key'])
    const previous = this.copies.get(key)
    if (previous) {
      if (previous.text !== request.text) throw new Error('COPY request identity changed')
      this.json(response, 201, previous.output, previous.output.revision)
      return
    }
    const body = parseWire('PokemonImportRequest', request.body)
    if (request.headers['if-match'] !== `"vault-${this.vault.revision}"`) {
      this.json(response, 409, {
        error: { code: 'stale_revision', message: 'Fixture COPY revision is stale' },
      })
      return
    }
    const count = body.kind === 'pkm' ? 1 : body.selections.length
    const imported = Array.from({ length: count }, () => {
      const pokemonId = id(this.nextCopyId++)
      const copy = record(this.pokemon.observed, pokemonId)
      copy.original_artifact_ids = [id(this.nextCopyId++)]
      copy.ohpkm_artifact_id = id(this.nextCopyId++)
      return copy
    })
    this.records.push(...imported)
    this.vault.content.metadata.push(...imported.map((item) => structuredClone(item.metadata)))
    this.vault.pokemon_count = this.records.length
    this.vault.pokedex = trackerCounts(this.records)
    this.vault.revision++
    this.copyCount += count
    const output: Wire.PokemonImportResult = {
      revision: this.vault.revision,
      pokemon: imported,
      artifacts: imported.flatMap((item) => [
        this.originalArtifact(item.id),
        {
          id: item.ohpkm_artifact_id,
          kind: 'canonical_ohpkm',
          format: 'ohpkm',
          sha256: this.pokemon.output.sha256,
          byte_length: this.pokemon.output.byte_length,
          created_at: '2026-11-17T10:00:00Z',
        } satisfies Wire.ArtifactSummary,
      ]),
    }
    this.copies.set(key, { text: request.text, output: structuredClone(output) })
    if (this.dropNextImport) {
      this.dropNextImport = false
      response.destroy()
      return
    }
    this.json(response, 201, output, output.revision)
  }

  joinOther() {
    this.trade.participants.push({
      user: { id: this.otherUser, username: 'other', role: 'member' },
      offer: [{ pokemon_id: this.foreignPokemon, observed: this.gen5.observed }],
      confirmed_offer_version: null,
    })
    this.trade.state = 'OPEN'
    this.trade.revision++
    this.trade.offer_version++
  }

  changeOtherOffer() {
    this.trade.participants[1].offer = [
      {
        pokemon_id: id(83),
        observed: { ...this.gen5.observed, nickname: 'Changed real summary' },
      },
    ]
    this.trade.offer_version++
    this.trade.revision++
    this.trade.participants.forEach((participant) => {
      participant.confirmed_offer_version = null
    })
  }

  private tradeAction(request: CapturedRequest, response: ServerResponse) {
    const key = parseWire('Id', request.headers['idempotency-key'])
    const previous = this.tradeReceipts.get(key)
    if (previous) {
      if (previous.text !== request.text) throw new Error('Trade retry body changed')
      this.respondTrade(response, 200, previous.output)
      return
    }
    const action = parseWire('TradeAction', request.body)
    if (
      request.headers['if-match'] !== `"trade-${this.trade.revision}"` ||
      (action.action !== 'cancel' && action.vault_if_match !== `"vault-${this.vault.revision}"`)
    ) {
      this.json(response, 409, {
        error: { code: 'stale_revision', message: 'Trade precondition is stale' },
      })
      return
    }
    if (action.action === 'offer') {
      this.trade.participants[0].offer = action.pokemon_ids.map((pokemonId) => {
        const pokemon = this.records.find((item) => item.id === pokemonId)
        if (!pokemon) throw new Error('UI offered a foreign UUID')
        return { pokemon_id: pokemonId, observed: pokemon.observed }
      })
      this.trade.offer_version++
      this.trade.participants.forEach((participant) => {
        participant.confirmed_offer_version = null
      })
      this.vault.revision++
      this.vault.reservations = action.pokemon_ids.map((pokemonId) => ({
        operation_id: this.trade.id,
        kind: 'trade',
        resource: { pokemon_id: pokemonId },
        expires_at: this.trade.expires_at,
      }))
    } else if (action.action === 'confirm') {
      if (action.offer_version !== this.trade.offer_version)
        throw new Error('UI consented to stale offers')
      this.trade.participants[0].confirmed_offer_version = action.offer_version
    } else {
      this.trade.state = 'CANCELLED'
      this.vault.revision++
      this.vault.reservations = []
    }
    this.trade.revision++
    const output = { trade: structuredClone(this.trade) }
    this.tradeReceipts.set(key, { text: request.text, output })
    if (this.dropNextTradeAction) {
      this.dropNextTradeAction = false
      response.destroy()
      return
    }
    this.respondTrade(response, 200, output)
  }

  private routes(request: CapturedRequest, response: ServerResponse): boolean {
    if (request.headers.authorization !== `Bearer ${this.bearer}` || !this.bearer) return false
    if (request.path === '/api/v1/status') {
      const status: Wire.Status = structuredClone(adapterStatus)
      status.engine.capabilities = [
        ...status.engine.capabilities.filter(
          (capability) => capability.operation !== 'convert_pkm'
        ),
        { operation: 'convert_pkm', input_format: 'ohpkm', output_formats: ['pk8', 'pk5'] },
        { operation: 'import_pkm', input_format: 'pk4', output_formats: ['ohpkm'] },
        { operation: 'import_pkm', input_format: 'pk5', output_formats: ['ohpkm'] },
      ]
      this.json(response, 200, status)
      return true
    }
    if (request.path === '/api/v1/pokemon/import') {
      this.copy(request, response)
      return true
    }
    if (request.path === '/api/v1/pokemon') {
      if (request.query.get('at_revision') !== String(this.vault.revision)) return false
      let items = this.records
      const q = request.query.get('q')?.toLowerCase()
      if (q)
        items = items.filter((item) =>
          [item.observed.nickname, ...item.metadata.tags].some((value) =>
            value.toLowerCase().includes(q)
          )
        )
      if (request.query.get('tag'))
        items = items.filter((item) => item.metadata.tags.includes(request.query.get('tag') ?? ''))
      if (request.query.get('favorite') === 'true')
        items = items.filter((item) => item.metadata.favorite)
      if (request.query.has('species'))
        items = items.filter(
          (item) => item.observed.species === Number(request.query.get('species'))
        )
      if (request.query.has('form'))
        items = items.filter((item) => item.observed.form === Number(request.query.get('form')))
      if (request.query.get('unplaced') === 'true') {
        const placed = new Set(
          this.vault.content.banks.flatMap((bank) => bank.boxes.flatMap((box) => box.slots))
        )
        items = items.filter((item) => !placed.has(item.id))
      }
      this.json(
        response,
        200,
        { revision: this.vault.revision, items, next_cursor: null } satisfies Wire.PokemonPage,
        this.vault.revision
      )
      return true
    }
    if (/^\/api\/v1\/pokemon\/[^/]+$/.test(request.path)) {
      const pokemonId = request.path.split('/').at(-1)
      const pokemon = this.records.find((item) => item.id === pokemonId)
      if (!pokemon) return false
      const original = this.originalArtifact(pokemon.id)
      const canonical: Wire.ArtifactSummary = {
        id: pokemon.ohpkm_artifact_id,
        kind: 'canonical_ohpkm',
        format: 'ohpkm',
        sha256: this.pokemon.output.sha256,
        byte_length: this.pokemon.output.byte_length,
        created_at: '2026-11-17T10:00:00Z',
      }
      this.json(
        response,
        200,
        {
          revision: this.vault.revision,
          pokemon,
          artifacts: [original, canonical],
        } satisfies Wire.PokemonView,
        this.vault.revision
      )
      return true
    }
    if (/^\/api\/v1\/pokemon\/[^/]+\/export$/.test(request.path)) {
      const body = parseWire('PokemonExportRequest', request.body)
      this.conversionAttempts.push(body)
      if (body.representation === 'converted' && !body.policy.allow_lossy) {
        this.json(response, 422, {
          error: {
            code: 'unsupported_conversion',
            message: 'Fixture requires explicit loss consent',
            details: { kind: 'unsupported', operation: 'convert_pkm', reason: 'loss_disallowed' },
          },
        } satisfies Wire.Error)
        return true
      }
      const output =
        body.representation === 'ohpkm'
          ? this.pokemon.output
          : body.representation === 'converted' && body.target_format === 'pk5'
            ? this.gen5.original
            : this.original
      const losses: Wire.Diagnostic[] =
        body.representation === 'converted'
          ? [
              {
                code: 'unsupported_metadata',
                field: 'openhome_metadata',
                message: 'OHPKM-only metadata is not representable in game PKM.',
              },
            ]
          : []
      this.json(
        response,
        200,
        { revision: this.vault.revision, output, losses } satisfies Wire.PokemonExportResult,
        this.vault.revision
      )
      return true
    }
    if (request.path === '/api/v1/saves/inspect') {
      const body = parseWire('SaveInspectRequest', request.body)
      const second = body.cursor === this.pageCursor
      const slots: Wire.SaveSlotPreview[] = second
        ? [
            { location: { kind: 'box', box: 1, slot: 0 }, pokemon: this.gen5 },
            { location: { kind: 'box', box: 1, slot: 1 }, pokemon: null },
          ]
        : [
            { location: { kind: 'box', box: 0, slot: 0 }, pokemon: this.gen5 },
            { location: { kind: 'box', box: 0, slot: 1 }, pokemon: this.gen5 },
            { location: { kind: 'box', box: 0, slot: 2 }, pokemon: null },
          ]
      this.json(response, 200, {
        detected: {
          family: 'gen5',
          generation: 5,
          box_count: 24,
          slots_per_box: 30,
          party_slots: 0,
        },
        save_sha256: body.input.sha256,
        slots,
        next_cursor: second ? null : this.pageCursor,
        slot_count: 720,
      } satisfies Wire.SaveInspectResult)
      return true
    }
    if (request.path === '/api/v1/metadata') {
      const kind = request.query.get('kind') ?? 'species'
      const items: Wire.ObservedItem[] =
        kind === 'forms'
          ? [
              {
                species: this.pokemon.observed.species,
                form: this.pokemon.observed.form,
                count: this.records.length,
              },
            ]
          : kind === 'moves'
            ? this.pokemon.observed.moves.map((move) => ({ move, count: this.records.length }))
            : kind === 'abilities' || kind === 'ribbons'
              ? []
              : [{ species: this.pokemon.observed.species, count: this.records.length }]
      const output = parseWire('MetadataPage', {
        revision: this.vault.revision,
        kind,
        items,
        next_cursor: null,
        favorite_count: this.records.filter((item) => item.metadata.favorite).length,
        tags: [...new Set(this.records.flatMap((item) => item.metadata.tags))].map((tag) => ({
          tag,
          count: this.records.filter((item) => item.metadata.tags.includes(tag)).length,
        })),
      })
      this.json(response, 200, output, this.vault.revision)
      return true
    }
    if (request.path === '/api/v1/trades' && request.method === 'POST') {
      this.respondTrade(response, 201, {
        trade: structuredClone(this.trade),
        join_code: this.joinCode,
      })
      return true
    }
    if (request.path === '/api/v1/trades/join') {
      const body = parseWire('TradeJoinRequest', request.body)
      if (body.join_code !== this.joinCode) throw new Error('Wrong join code')
      this.trade.participants.push({
        user: { id: USER, username: 'owner', role: 'admin' },
        offer: [],
        confirmed_offer_version: null,
      })
      this.trade.state = 'OPEN'
      this.trade.revision++
      this.respondTrade(response, 200, { trade: structuredClone(this.trade) })
      return true
    }
    if (request.path === `/api/v1/trades/${this.tradeId}`) {
      this.respondTrade(response, 200, { trade: structuredClone(this.trade) })
      return true
    }
    if (request.path === `/api/v1/trades/${this.tradeId}/actions`) {
      this.tradeAction(request, response)
      return true
    }
    if (request.path === '/api/v1/transfers' && request.method === 'POST') {
      const body = parseWire('PrepareTransferRequest', request.body)
      const bytes = new Uint8Array(this.save)
      bytes[100] ^= 1
      this.preparedSave = {
        data_base64: encodeBase64(bytes),
        sha256: sha256(bytes),
        byte_length: bytes.length,
        family: 'gen5',
      }
      this.vault.revision++
      this.vault.reservations =
        body.plan.direction === 'withdraw'
          ? body.plan.entries.map((entry) => ({
              operation_id: body.transfer_id,
              kind: 'transfer',
              resource: { pokemon_id: entry.pokemon_id },
              expires_at: new Date(Date.now() + 600_000).toISOString(),
            }))
          : []
      this.transfer = {
        revision: this.vault.revision,
        transfer: {
          id: body.transfer_id,
          state: 'PREPARED',
          plan: body.plan,
          write_authorized: true,
          original_save: {
            id: id(90),
            kind: 'original_save',
            format: 'gen5',
            sha256: body.original_save.sha256,
            byte_length: this.save.length,
            created_at: new Date().toISOString(),
          },
          prepared_save: {
            id: id(91),
            kind: 'prepared_save',
            format: 'gen5',
            sha256: this.preparedSave.sha256,
            byte_length: bytes.length,
            created_at: new Date().toISOString(),
          },
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          local_applied_at: null,
          outcome: null,
          recovery: 'none',
        },
        artifact: this.preparedSave,
      }
      this.json(response, 201, this.transfer, this.vault.revision)
      return true
    }
    if (this.transfer && request.path === `/api/v1/transfers/${this.transfer.transfer.id}`) {
      const which = request.query.get('artifact')
      const artifact =
        which === 'prepared'
          ? this.preparedSave
          : which === 'original'
            ? ({
                data_base64: encodeBase64(this.save),
                sha256: sha256(this.save),
                byte_length: this.save.length,
                family: 'gen5',
              } satisfies Wire.SaveBytes)
            : undefined
      const output = {
        revision: this.vault.revision,
        transfer: this.transfer.transfer,
        ...(artifact && { artifact }),
      }
      this.json(response, 200, output, this.vault.revision)
      return true
    }
    if (
      this.transfer &&
      request.path === `/api/v1/transfers/${this.transfer.transfer.id}/actions`
    ) {
      const body = parseWire('TransferAction', request.body)
      if (body.action !== 'cancel')
        throw new Error('Browser falsely claimed local apply/finalization')
      this.transfer.transfer.state = 'CANCELLED'
      this.vault.revision++
      this.vault.reservations = []
      this.transfer.revision = this.vault.revision
      this.json(
        response,
        200,
        {
          revision: this.vault.revision,
          transfer: this.transfer.transfer,
        } satisfies Wire.TransferView,
        this.vault.revision
      )
      return true
    }
    return false
  }
}

export { ARTIFACT, id, ORIGINAL, POKEMON, USER }
