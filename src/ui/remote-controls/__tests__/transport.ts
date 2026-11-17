import {
  type Bundle,
  type Device,
  type EventSocket,
  type PokemonRecord,
  RemoteBackend,
  type SessionGrant,
  type Snapshot,
  type User,
} from '@openhome-core/remote'
import { parseJson, parseWire } from '@openhome-core/remote/validation'
import { id, initialVault, status } from '@openhome-core/remote/__test__/support'

export interface UiRequest {
  url: URL
  method: string
  headers: Headers
  text: string
  body: unknown
}

export class QuietSocket implements EventSocket {
  readyState = 0
  onopen: EventSocket['onopen'] = null
  onmessage: EventSocket['onmessage'] = null
  onclose: EventSocket['onclose'] = null
  onerror: EventSocket['onerror'] = null
  send(_data: string) {}
  close() {
    this.readyState = 3
  }
}

// A typed, in-memory HTTP transport fixture, not the Rust service or an E2E tier.
export class UiTransport {
  readonly requests: UiRequest[] = []
  user: User = { id: id(6), username: 'owner', role: 'admin' }
  records: PokemonRecord[] = []
  vault = initialVault(this.records)
  bearer?: string
  loseLoginResponse = false
  failLogout = false
  unauthorized = false
  devices: Device[] = [
    {
      id: id(20),
      name: 'Living room 3DS',
      created_at: '2026-01-01T00:00:00Z',
      expires_at: '2099-01-01T00:00:00Z',
      revoked_at: null,
    },
  ]
  snapshots: Snapshot[] = [
    {
      id: id(30),
      label: 'Before changes',
      source_revision: 0,
      created_at: '2026-01-01T00:00:00Z',
      reason: 'manual',
    },
  ]
  bundle?: Bundle
  intercept?: (request: UiRequest) => Response | undefined | Promise<Response | undefined>

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    const request: UiRequest = {
      url: new URL(raw),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      text: typeof init?.body === 'string' ? init.body : '',
      body: typeof init?.body === 'string' ? parseJson(init.body) : undefined,
    }
    this.requests.push(request)
    const intercepted = await this.intercept?.(request)
    if (intercepted) return intercepted
    const path = request.url.pathname
    if (path === '/api/v1/auth/login' || path === '/api/v1/auth/bootstrap') {
      const login = parseWire('LoginRequest', request.body)
      this.bearer = login.token
      const grant: SessionGrant = {
        user: { ...this.user, username: login.username },
        session_id: id(7),
        expires_at: '2099-01-01T00:00:00Z',
        vault_revision: this.vault.revision,
      }
      if (this.loseLoginResponse) {
        this.loseLoginResponse = false
        throw new TypeError('Unit transport lost an already accepted response')
      }
      return this.json(grant, undefined, path.endsWith('/bootstrap') ? 201 : 200)
    }
    if (
      this.unauthorized ||
      !this.bearer ||
      request.headers.get('Authorization') !== `Bearer ${this.bearer}`
    )
      return this.error(401, 'unauthorized', 'Authentication failed')
    if (path === '/api/v1/auth/logout') {
      if (this.failLogout) throw new TypeError('Unit transport is offline')
      this.bearer = undefined
      return new Response(null, { status: 204 })
    }
    if (path === '/api/v1/status') return this.json(status)
    if (path === '/api/v1/vault') return this.json(this.vault, this.vault.revision)
    if (path === '/api/v1/pokemon')
      return this.json(
        {
          revision: this.vault.revision,
          items: this.records,
          next_cursor: null,
        },
        this.vault.revision
      )
    if (path === '/api/v1/pairing/codes')
      return this.json(
        {
          id: id(21),
          generation: 1,
          code: '001234',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          attempts_remaining: 10,
        },
        undefined,
        201
      )
    if (path === '/api/v1/devices') return this.json({ items: this.devices, next_cursor: null })
    if (path.startsWith('/api/v1/devices/') && request.method === 'DELETE') {
      this.devices = this.devices.map((device) =>
        path.endsWith(device.id) ? { ...device, revoked_at: new Date().toISOString() } : device
      )
      return new Response(null, { status: 204 })
    }
    if (path === '/api/v1/auth/users') {
      const user = parseWire('CreateUserRequest', request.body)
      if (this.user.role !== 'admin') return this.error(403, 'forbidden', 'Human admin required')
      return this.json({ id: id(22), username: user.username, role: user.role }, undefined, 201)
    }
    if (path === '/api/v1/snapshots' && request.method === 'GET')
      return this.json(
        {
          revision: this.vault.revision,
          items: this.snapshots,
          next_cursor: null,
        },
        this.vault.revision
      )
    if (path === '/api/v1/snapshots' && request.method === 'POST') {
      if (request.headers.get('If-Match') !== `"vault-${this.vault.revision}"`)
        return this.error(409, 'stale_revision', 'A different revision is current')
      const { label } = parseWire('CreateSnapshotRequest', request.body)
      const snapshot: Snapshot = {
        id: id(31),
        label,
        source_revision: this.vault.revision,
        created_at: new Date().toISOString(),
        reason: 'manual',
      }
      this.vault.revision++
      this.snapshots.push(snapshot)
      return this.json({ revision: this.vault.revision, snapshot }, this.vault.revision, 201)
    }
    if (path.endsWith('/restore') && request.method === 'POST') {
      if (request.headers.get('If-Match') !== `"vault-${this.vault.revision}"`)
        return this.error(409, 'stale_revision', 'A different revision is current')
      this.vault.revision++
      return this.json(
        {
          revision: this.vault.revision,
          restored_snapshot_id: id(30),
          id_map: [{ kind: 'pokemon', source_id: id(40), destination_id: id(41) }],
        },
        this.vault.revision
      )
    }
    if (path === '/api/v1/bundles/export' || path.endsWith('/export')) {
      if (!this.bundle) return this.error(503, 'storage_unavailable', 'No fixture bundle supplied')
      return this.json(this.bundle, this.vault.revision)
    }
    return this.error(404, 'not_found', 'No test route')
  }

  backend(baseUrl = 'https://household.test') {
    return new RemoteBackend({
      baseUrl,
      fetch: this.fetch,
      socketFactory: () => new QuietSocket(),
    })
  }

  json(data: unknown, revision?: number, responseStatus = 200) {
    return new Response(JSON.stringify(data), {
      status: responseStatus,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(revision !== undefined && { ETag: `"vault-${revision}"` }),
      },
    })
  }

  error(status: number, code: string, message: string) {
    return new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...(status === 401 && { 'WWW-Authenticate': 'Bearer' }),
      },
    })
  }
}
