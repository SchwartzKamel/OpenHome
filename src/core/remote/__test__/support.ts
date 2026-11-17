import { bytesToPKM } from '@openhome-core/pkm/FileImport'
import { OHPKM } from '@openhome-core/pkm/OHPKM'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { decodeBytes, encodeBase64, sha256 } from '../crypto'
import { applyCommands, trackerCounts } from '../state'
import { parseJson, parseWire } from '../validation'
import type * as Wire from '../wire-types'

export const id = (value: number) =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
export const BANK = id(1)
export const BOX = id(2)
export const POKEMON = id(3)
export const ARTIFACT = id(4)
export const ORIGINAL = id(5)
export const USER = id(6)

export interface CapturedRequest {
  path: string
  method: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  text: string
  body: unknown
}

export function realPokemon() {
  const original = new Uint8Array(
    readFileSync(resolve('test-files/pkm-files/pk8/toxtricity-garbage-bytes.pk8'))
  )
  const source = bytesToPKM(original, 'PK8')
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
    source_generation: 8,
  }
  const identifier = mon.openhomeId
  mon.free()
  const output: Wire.OhpkmBytes = {
    data_base64: encodeBase64(binary),
    sha256: sha256(binary),
    byte_length: binary.length,
    format: 'ohpkm',
  }
  return { original, binary, identifier, observed, output }
}

export function initialVault(records: Wire.PokemonRecord[]): Wire.VaultState {
  return {
    view: 'full',
    revision: 0,
    content: {
      banks: [
        {
          id: BANK,
          name: 'Household',
          boxes: [
            {
              id: BOX,
              name: 'First box',
              slots: Array.from({ length: 30 }, (_, slot) =>
                slot === 0 && records[0] ? records[0].id : null
              ),
            },
          ],
        },
      ],
      settings: {
        theme: 'system',
        language: 'en',
        sort: 'manual',
        snapshot_retention: 10,
        default_strategy_id: null,
      },
      lookups: [],
      conversion_strategies: [],
      metadata: records.map((record) => structuredClone(record.metadata)),
    },
    pokemon_count: records.length,
    pokedex: trackerCounts(records),
    reservations: [],
  }
}

export function record(observed: Wire.ObservedPokemon, pokemonId = POKEMON): Wire.PokemonRecord {
  return {
    id: pokemonId,
    observed,
    metadata: { pokemon_id: pokemonId, favorite: false, tags: [] },
    original_artifact_ids: [ORIGINAL],
    ohpkm_artifact_id: ARTIFACT,
    imported_at: '2026-11-17T10:00:00Z',
  }
}

export const status: Wire.Status = {
  api_version: 'v1',
  ready: true,
  limits: {
    pkm_bytes: 1_048_576,
    save_bytes: 16_777_216,
    worker_line_bytes: 33_554_432,
    normal_body_bytes: 4_194_304,
    save_body_bytes: 33_554_432,
    bundle_body_bytes: 201_326_592,
    vault_blob_bytes: 134_217_728,
    vault_metadata_bytes: 16_777_216,
    pokemon_per_vault: 10_000,
    page_size: 100,
  },
  engine: {
    upstream_revision: '6b6a81d3468e105b9fbbe9dd175148281af54ce3',
    worker_version: 'adapter-unit-fixture',
    capabilities: [
      { operation: 'inspect_pkm', input_format: 'pk8', output_formats: ['ohpkm'] },
      { operation: 'import_pkm', input_format: 'pk8', output_formats: ['ohpkm'] },
      { operation: 'convert_pkm', input_format: 'ohpkm', output_formats: ['pk8'] },
      { operation: 'inspect_save', input_format: 'gen5', output_formats: ['pk5'] },
      { operation: 'prepare_save', input_format: 'gen5', output_formats: ['pk5'] },
    ],
  },
  features: { native_writes_enabled: false, native_write_families: [] },
}

// An isolated real HTTP boundary, NOT the product Rust service or an end-to-end tier.
export class HouseholdServer {
  private server?: Server
  baseUrl = ''
  readonly requests: CapturedRequest[] = []
  readonly pokemon = realPokemon()
  records = [record(this.pokemon.observed)]
  vault = initialVault(this.records)
  bearer?: string
  conflictNextCommit = false
  dropNextCommit = false
  forceUnauthorized = false
  private readonly receipts = new Map<string, { text: string; output: Wire.VaultCommitResult }>()
  custom?: (request: CapturedRequest, response: ServerResponse) => boolean | Promise<boolean>

  async start() {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString('utf8')
        const url = new URL(request.url ?? '/', 'http://localhost')
        const captured: CapturedRequest = {
          method: request.method ?? '',
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          text,
          body: text ? parseJson(text) : undefined,
        }
        this.requests.push(captured)
        if (await this.custom?.(captured, response)) return
        this.handle(captured, response)
      })().catch(() =>
        this.json(response, 500, {
          error: { code: 'internal_error', message: 'Unit HTTP fixture failed' },
        })
      )
    })
    await new Promise<void>((ready, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', ready)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('No ephemeral test listener')
    this.baseUrl = `http://127.0.0.1:${address.port}`
  }

  async stop() {
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }

  json(response: ServerResponse, statusCode: number, body: unknown, revision?: number) {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    if (revision !== undefined) response.setHeader('ETag', `"vault-${revision}"`)
    response.writeHead(statusCode)
    response.end(statusCode === 204 ? undefined : JSON.stringify(body))
  }

  private handle(request: CapturedRequest, response: ServerResponse) {
    if (request.path === '/api/v1/auth/login') {
      const login = parseWire('LoginRequest', request.body)
      this.bearer = login.token
      this.json(response, 200, {
        user: { id: USER, username: login.username, role: 'admin' },
        session_id: id(7),
        expires_at: '2026-11-17T22:00:00Z',
        vault_revision: this.vault.revision,
      } satisfies Wire.SessionGrant)
      return
    }
    if (
      this.forceUnauthorized ||
      request.headers.authorization !== `Bearer ${this.bearer}` ||
      !this.bearer
    ) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      this.json(response, 401, {
        error: { code: 'unauthorized', message: 'Authentication failed' },
      })
      return
    }
    if (request.path === '/api/v1/status') return this.json(response, 200, status)
    if (request.path === '/api/v1/auth/logout') {
      this.json(response, 204, null)
      this.bearer = undefined
      return
    }
    if (request.path === '/api/v1/vault')
      return this.json(response, 200, this.vault, this.vault.revision)
    if (request.path === '/api/v1/pokemon') {
      if (Number(request.query.get('at_revision')) !== this.vault.revision) {
        return this.json(response, 409, {
          error: { code: 'stale_revision', message: 'Traversal is stale' },
        })
      }
      return this.json(
        response,
        200,
        {
          revision: this.vault.revision,
          items: this.records,
          next_cursor: null,
        } satisfies Wire.PokemonPage,
        this.vault.revision
      )
    }
    if (/^\/api\/v1\/pokemon\/[^/]+\/export$/.test(request.path)) {
      parseWire('PokemonExportRequest', request.body)
      decodeBytes(this.pokemon.output)
      return this.json(
        response,
        200,
        {
          revision: this.vault.revision,
          output: this.pokemon.output,
          losses: [],
        } satisfies Wire.PokemonExportResult,
        this.vault.revision
      )
    }
    if (request.path === '/api/v1/vault/commit') {
      const key = parseWire('Id', request.headers['idempotency-key'])
      const previous = this.receipts.get(key)
      if (previous) {
        if (previous.text !== request.text) {
          return this.json(response, 409, {
            error: { code: 'idempotency_conflict', message: 'Body changed' },
          })
        }
        return this.json(response, 200, previous.output, previous.output.revision)
      }
      if (
        this.conflictNextCommit ||
        request.headers['if-match'] !== `"vault-${this.vault.revision}"`
      ) {
        this.conflictNextCommit = false
        return this.json(response, 409, {
          error: {
            code: 'stale_revision',
            message: 'Another client changed the vault',
            details: { kind: 'revision', current_etag: `"vault-${this.vault.revision}"` },
          },
        })
      }
      const body = parseWire('VaultCommitRequest', request.body)
      const activeIds = new Set(this.records.map((record) => record.id))
      this.vault.content =
        body.mode === 'replace'
          ? body.state
          : applyCommands(this.vault.content, body.commands, activeIds)
      this.records = this.records
        .filter((record) => activeIds.has(record.id))
        .map((record) => ({
          ...record,
          metadata:
            this.vault.content.metadata.find((entry) => entry.pokemon_id === record.id) ??
            record.metadata,
        }))
      this.vault.pokemon_count = this.records.length
      this.vault.pokedex = trackerCounts(this.records)
      this.vault.revision++
      const output = {
        revision: this.vault.revision,
        applied_commands: body.mode === 'delta' ? body.commands.length : 1,
      }
      this.receipts.set(key, { text: request.text, output })
      if (this.dropNextCommit) {
        this.dropNextCommit = false
        response.destroy()
        return
      }
      return this.json(response, 200, output, output.revision)
    }
    this.json(response, 404, { error: { code: 'not_found', message: 'No unit fixture route' } })
  }
}
