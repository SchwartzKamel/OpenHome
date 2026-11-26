import { decodeBytes, newBearer, newId } from './crypto'
import { RemoteError, remoteError } from './errors'
import { isObject, parseJson, parseWire, validate, type Schema } from './validation'
import frozen from './wire-schema.json'
import type * as Wire from './wire-types'

export type Operation = keyof Wire.ApiOperations
export type Input<N extends Operation> = Wire.ApiOperations[N]['input']
export type Output<N extends Operation> = Wire.ApiOperations[N]['output']

interface OperationDefinition {
  method: string
  path: string
  auth: string
  durable: boolean
  revision: string
  bodyMaxBytes: number
  status: number
  pathSchema: Schema
  querySchema: Schema
  bodySchema?: Schema
  outputSchema?: Schema
  etag?: string
}

const operations: Readonly<Record<Operation, OperationDefinition>> = frozen.operations

export interface ApiResponse<T> {
  data: T
  etag?: string
}

export interface PreparedRequest<T> {
  readonly idempotencyKey?: string
  readonly operation: Operation
  send(): Promise<ApiResponse<T>>
}

interface RequestOwner {
  generation: number
  intent: number
  bearer: boolean
  token?: string
  proof?: number
}

export interface CredentialStore {
  read(): string | undefined
  write(token: string | undefined): void
}

export class MemoryCredentialStore implements CredentialStore {
  private token?: string
  read = () => this.token
  write = (token: string | undefined) => {
    this.token = token
  }
}

export interface RemoteClientOptions {
  baseUrl: string
  acknowledgeInsecureHttp?: boolean
  fetch?: typeof globalThis.fetch
  credentials?: CredentialStore
}

export type TransportSecurity =
  | 'https'
  | 'insecure-http-unacknowledged'
  | 'insecure-http-acknowledged'

export class RemoteClient {
  readonly baseUrl: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly credentials: CredentialStore
  private insecureAcknowledged: boolean
  private readonly credentialListeners = new Set<() => void>()
  private readonly mutationListeners = new Set<(operation: Operation) => void>()
  private epoch = 0
  private credentialIntent = 0
  private observerFailure?: RemoteError

  constructor(options: RemoteClientOptions) {
    const url = new URL(options.baseUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new RemoteError(
        'invalid_request',
        'Server address must be an HTTP(S) origin without credentials, path, query or fragment'
      )
    }
    this.baseUrl = url.origin
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.credentials = options.credentials ?? new MemoryCredentialStore()
    this.insecureAcknowledged = options.acknowledgeInsecureHttp ?? false
    const stored = this.credentials.read()
    if (stored) parseWire('BearerToken', stored)
  }

  get generation(): number {
    return this.epoch
  }

  get observerError(): RemoteError | undefined {
    return this.observerFailure
  }

  private observe(callback: () => void) {
    try {
      callback()
    } catch {
      // Observer bugs cannot change the outcome of an already acknowledged mutation.
      this.observerFailure = new RemoteError(
        'internal_error',
        'A client credential or mutation observer failed'
      )
    }
  }

  get authenticated(): boolean {
    return this.credentials.read() !== undefined
  }

  get transportSecurity(): TransportSecurity {
    return this.baseUrl.startsWith('https:')
      ? 'https'
      : this.insecureAcknowledged
        ? 'insecure-http-acknowledged'
        : 'insecure-http-unacknowledged'
  }

  acknowledgeInsecureHttp = () => {
    this.insecureAcknowledged = true
  }

  subscribeCredentials = (listener: () => void): (() => void) => {
    this.credentialListeners.add(listener)
    return () => this.credentialListeners.delete(listener)
  }

  subscribeMutations = (listener: (operation: Operation) => void): (() => void) => {
    this.mutationListeners.add(listener)
    return () => this.mutationListeners.delete(listener)
  }

  clearCredentials = () => this.forgetCredential(true)

  private forgetCredential(cancelProofs: boolean) {
    this.credentials.write(undefined)
    this.epoch++
    if (cancelProofs) this.credentialIntent++
    this.observerFailure = undefined
    for (const listener of this.credentialListeners) this.observe(listener)
  }

  private ownsRequest(owner: RequestOwner): boolean {
    if (owner.proof !== undefined) return owner.proof === this.credentialIntent
    return (
      owner.generation === this.epoch && (!owner.bearer || owner.token === this.credentials.read())
    )
  }

  private requireOwner(owner: RequestOwner) {
    if (!this.ownsRequest(owner)) {
      throw new RemoteError(
        'cancelled',
        'This request belongs to an earlier connection or credential attempt'
      )
    }
  }

  private acceptCredential(token: string) {
    this.credentials.write(parseWire('BearerToken', token))
    this.epoch++
    const generation = this.epoch
    this.observerFailure = undefined
    for (const listener of this.credentialListeners) this.observe(listener)
    return generation
  }

  eventAuthentication(afterSequence?: number): Wire.EventAuthenticate {
    this.assertTransport()
    const token = this.credentials.read()
    if (!token) throw new RemoteError('unauthorized', 'Authentication failed', 401)
    return parseWire('EventAuthenticate', {
      type: 'authenticate',
      token,
      ...(afterSequence !== undefined && { after_sequence: afterSequence }),
    })
  }

  beginLogin(username: string, password: string): PreparedRequest<Wire.SessionGrant> {
    const token = newBearer()
    return this.exchange(this.prepare('login', { body: { username, password, token } }), token)
  }

  beginBootstrap(
    username: string,
    password: string,
    setupToken: string
  ): PreparedRequest<Wire.SessionGrant> {
    const token = newBearer()
    return this.exchange(
      this.prepare('bootstrap', { body: { username, password, token }, setupToken }),
      token
    )
  }

  beginClaim(username: string, code: string, name: string): PreparedRequest<Wire.DeviceGrant> {
    const token = newBearer()
    return this.exchange(
      this.prepare('claimPairingCode', { body: { username, code, name, token } }),
      token
    )
  }

  private exchange<T>(request: PreparedRequest<T>, token: string): PreparedRequest<T> {
    let accepted: ApiResponse<T> | undefined
    let activatedAt: number | undefined
    let inFlight: Promise<ApiResponse<T>> | undefined
    const proof = this.credentialIntent
    return {
      operation: request.operation,
      idempotencyKey: request.idempotencyKey,
      send: () => {
        if (accepted) {
          return this.epoch === activatedAt && proof === this.credentialIntent
            ? Promise.resolve(accepted)
            : Promise.reject(new RemoteError('cancelled', 'This credential exchange was cleared'))
        }
        inFlight ??= (async () => {
          const response = await request.send()
          if (proof !== this.credentialIntent) {
            throw new RemoteError(
              'cancelled',
              'The credential exchange belongs to an earlier connection'
            )
          }
          activatedAt = this.acceptCredential(token)
          if (
            proof !== this.credentialIntent ||
            activatedAt !== this.epoch ||
            this.credentials.read() !== token
          ) {
            throw new RemoteError(
              'cancelled',
              'This credential exchange was superseded during activation'
            )
          }
          accepted = response
          return response
        })().finally(() => {
          inFlight = undefined
        })
        return inFlight
      },
    }
  }

  logout = async (): Promise<void> => {
    this.credentialIntent++
    const owner: RequestOwner = {
      generation: this.epoch,
      intent: this.credentialIntent,
      bearer: true,
      token: this.credentials.read(),
    }
    try {
      await this.prepare('logout', { body: {} }).send()
    } finally {
      if (this.ownsRequest(owner)) {
        this.forgetCredential(owner.intent === this.credentialIntent)
      }
    }
  }

  call<N extends Operation>(operation: N, input: Input<N>): Promise<ApiResponse<Output<N>>> {
    return this.prepare(operation, input).send()
  }

  prepare<N extends Operation>(operation: N, input: Input<N>): PreparedRequest<Output<N>> {
    const definition = operations[operation]
    const options: unknown = input
    if (!isObject(options)) throw new RemoteError('invalid_request', 'A typed request is required')
    const allowed = new Set(['path', 'query', 'body', 'ifMatch', 'idempotencyKey', 'setupToken'])
    if (Object.keys(options).some((key) => !allowed.has(key))) {
      throw new RemoteError('invalid_request', 'Unknown request option')
    }
    const pathValues = options.path ?? {}
    const queryValues = options.query ?? {}
    validate(definition.pathSchema, pathValues, '/path')
    validate(definition.querySchema, queryValues, '/query')
    if (!isObject(pathValues) || !isObject(queryValues)) {
      throw new RemoteError('invalid_request', 'Invalid request parameters')
    }
    if (operation === 'getVault') {
      const box = queryValues.view === 'box'
      if (box !== ('bank_id' in queryValues && 'box_id' in queryValues)) {
        throw new RemoteError('invalid_request', 'Box view requires both bank_id and box_id')
      }
      if (!box && ('bank_id' in queryValues || 'box_id' in queryValues)) {
        throw new RemoteError('invalid_request', 'Bank/box selectors require box view')
      }
    }
    if (
      operation === 'listPokemon' &&
      queryValues.form !== undefined &&
      queryValues.species === undefined
    ) {
      throw new RemoteError('invalid_request', 'A form filter requires species')
    }
    let path = definition.path
    for (const [name, value] of Object.entries(pathValues)) {
      if (typeof value !== 'string')
        throw new RemoteError('invalid_request', 'Invalid path parameter')
      path = path.replace(`{${name}}`, encodeURIComponent(value))
    }
    const url = new URL(path, this.baseUrl)
    for (const [name, value] of Object.entries(queryValues)) {
      if (value !== undefined) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new RemoteError('invalid_request', 'Invalid query parameter')
        }
        url.searchParams.set(name, String(value))
      }
    }
    const headers = new Headers({ Accept: 'application/json' })
    let body: string | undefined
    if (definition.bodySchema) {
      validate(definition.bodySchema, options.body, '/body')
      body = JSON.stringify(options.body)
      // Round-trip also rejects non-finite numbers, invalid surrogates and inherited/toJSON surprises.
      const parsed = parseJson(body)
      validate(definition.bodySchema, parsed, '/body')
      verifyBinaries(parsed)
      if (new TextEncoder().encode(body).length > definition.bodyMaxBytes) {
        throw new RemoteError(
          'limit_exceeded',
          'The request exceeds the frozen operation body limit'
        )
      }
      headers.set('Content-Type', 'application/json')
    } else if (options.body !== undefined) {
      throw new RemoteError('invalid_request', 'This operation has no request body')
    }
    const idempotencyKey = definition.durable
      ? parseWire('Id', options.idempotencyKey ?? newId())
      : undefined
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
    if (definition.durable && definition.revision !== 'none') {
      headers.set(
        'If-Match',
        parseWire(definition.revision === 'vault' ? 'VaultETag' : 'TradeETag', options.ifMatch)
      )
    }
    if (definition.auth === 'setup') {
      if (typeof options.setupToken !== 'string' || !options.setupToken) {
        throw new RemoteError('invalid_request', 'A setup secret is required')
      }
      headers.set('X-Setup-Token', options.setupToken)
    }
    const proof =
      operation === 'login' || operation === 'bootstrap' || operation === 'claimPairingCode'
        ? ++this.credentialIntent
        : undefined
    const owner: RequestOwner = {
      generation: this.epoch,
      intent: this.credentialIntent,
      bearer: definition.auth === 'bearer',
      token: definition.auth === 'bearer' ? this.credentials.read() : undefined,
      proof,
    }
    let inFlight: Promise<ApiResponse<Output<N>>> | undefined
    return {
      operation,
      idempotencyKey,
      send: () => {
        inFlight ??= this.send<Output<N>>(definition, url, headers, body, owner)
          .then((response) => {
            this.requireOwner(owner)
            if (definition.durable && definition.auth === 'bearer') {
              for (const listener of this.mutationListeners) {
                this.requireOwner(owner)
                this.observe(() => listener(operation))
              }
            }
            this.requireOwner(owner)
            return response
          })
          .finally(() => {
            inFlight = undefined
          })
        return inFlight
      },
    }
  }

  private assertTransport() {
    if (this.transportSecurity === 'insecure-http-unacknowledged') {
      throw new RemoteError(
        'insecure_transport',
        'HTTP exposes passwords and collection data on the LAN. Explicit acknowledgement is required.'
      )
    }
  }

  private async send<T>(
    definition: OperationDefinition,
    url: URL,
    originalHeaders: Headers,
    body: string | undefined,
    owner: RequestOwner
  ): Promise<ApiResponse<T>> {
    this.assertTransport()
    this.requireOwner(owner)
    const headers = new Headers(originalHeaders)
    if (definition.auth === 'bearer') {
      const token = owner.token
      if (!token) throw new RemoteError('unauthorized', 'Authentication failed', 401)
      headers.set('Authorization', `Bearer ${token}`)
    }
    const controller = new AbortController()
    const bundle =
      definition.path.includes('/bundles/') ||
      (definition.path.includes('/snapshots/') && definition.path.endsWith('/export'))
    const timeout =
      definition === operations.restoreSnapshot
        ? 65_000
        : bundle
          ? 60_000
          : definition.bodyMaxBytes >= 33_554_432 || definition.path.endsWith('/export')
            ? 40_000
            : 10_000
    const timer = setTimeout(() => controller.abort(), timeout)
    let response: Response | undefined
    let ownedUnauthorized = false
    try {
      response = await this.fetcher(url, {
        method: definition.method,
        headers,
        body,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
      this.requireOwner(owner)
      if (response.status === 401) {
        ownedUnauthorized = true
        // Revoke only this request's credential/proof. A newer pending login is
        // independent of the old bearer, and a replacement bearer is never cleared.
        this.forgetCredential(owner.proof !== undefined || owner.intent === this.credentialIntent)
        void response.body?.cancel().catch(() => undefined)
        throw new RemoteError('unauthorized', 'Authentication failed', 401)
      }
      const content = await readBody(response, bundle ? 201_326_592 : 33_554_432)
      this.requireOwner(owner)
      if (!response.ok) {
        let error: Wire.Error | undefined
        try {
          error = parseWire('Error', parseJson(content))
        } catch {
          throw new RemoteError(
            response.status === 401 ? 'unauthorized' : 'protocol_error',
            response.status === 401
              ? 'Authentication failed'
              : `HTTP ${response.status}: invalid v1 error response`,
            response.status
          )
        }
        const retryAfter = response.headers.get('Retry-After')
        throw new RemoteError(
          error.error.code,
          error.error.message,
          response.status,
          error.error.details,
          false,
          retryAfter && /^[1-9]\d*$/.test(retryAfter) ? Number(retryAfter) : undefined
        )
      }
      if (response.status !== definition.status) {
        throw new RemoteError('protocol_error', `Unexpected HTTP success status ${response.status}`)
      }
      if (!definition.outputSchema) {
        if (content !== '')
          throw new RemoteError('protocol_error', 'Expected an empty 204 response')
        return { data: null as T }
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
        throw new RemoteError('protocol_error', 'Expected an application/json response')
      }
      const parsed = parseJson(content)
      validate(definition.outputSchema, parsed)
      verifyBinaries(parsed)
      this.requireOwner(owner)
      const etag = response.headers.get('ETag') ?? undefined
      if (definition.etag) {
        parseWire(definition.etag === 'vault' ? 'VaultETag' : 'TradeETag', etag)
        const revision = responseRevision(parsed, definition.etag)
        if (revision !== undefined && etag !== `"${definition.etag}-${revision}"`) {
          throw new RemoteError('protocol_error', 'Response ETag does not match its revision')
        }
      }
      this.requireOwner(owner)
      return { data: parsed as T, etag }
    } catch (error) {
      if (!ownedUnauthorized) this.requireOwner(owner)
      const failure = remoteError(error)
      if (failure.code === 'cancelled' || failure.httpStatus) throw failure
      const uncertain = definition.durable && (!response || response.ok)
      throw new RemoteError(
        error instanceof RemoteError ? failure.code : 'network_error',
        error instanceof RemoteError ? failure.message : 'The server request failed or timed out',
        response?.status,
        failure.details,
        uncertain
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

function verifyBinaries(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(verifyBinaries)
  } else if (isObject(value)) {
    if (typeof value.data_base64 === 'string' && typeof value.sha256 === 'string') {
      const length =
        typeof value.byte_length === 'number'
          ? value.byte_length
          : (value.data_base64.length / 4) * 3 -
            (value.data_base64.endsWith('==') ? 2 : value.data_base64.endsWith('=') ? 1 : 0)
      const maximum = 'family' in value || 'family_hint' in value ? 16_777_216 : 1_048_576
      if (length < 1 || length > maximum) {
        throw new RemoteError('limit_exceeded', 'Binary content exceeds its raw byte limit')
      }
      decodeBytes({ data_base64: value.data_base64, sha256: value.sha256, byte_length: length })
    } else {
      Object.values(value).forEach(verifyBinaries)
    }
  }
}

function responseRevision(value: unknown, kind: string): number | undefined {
  if (!isObject(value)) return undefined
  const revision =
    kind === 'trade' && isObject(value.trade)
      ? value.trade.revision
      : (value.revision ?? value.source_revision)
  return typeof revision === 'number' ? revision : undefined
}

async function readBody(response: Response, maximum: number): Promise<string> {
  const length = response.headers.get('Content-Length')
  if (length && Number(length) > maximum) {
    await response.body?.cancel()
    throw new RemoteError('limit_exceeded', 'The server response exceeds the frozen output limit')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maximum) {
        throw new RemoteError(
          'limit_exceeded',
          'The server response exceeds the frozen output limit'
        )
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
