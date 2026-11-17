// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteBackend } from '../backend'
import type { EventSocket } from '../events'
import { parseJson, parseWire } from '../validation'
import type * as Wire from '../wire-types'
import { HouseholdServer, USER } from './support'

class Socket implements EventSocket {
  readyState = 0
  onopen: EventSocket['onopen'] = null
  onmessage: EventSocket['onmessage'] = null
  onclose: EventSocket['onclose'] = null
  onerror: EventSocket['onerror'] = null
  readonly sent: string[] = []
  readonly closes: number[] = []
  constructor(
    readonly url: string,
    readonly protocol: string
  ) {}
  send = (text: string) => {
    this.sent.push(text)
  }
  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }
  receive(frame: Wire.EventServerFrame) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
  close(code = 1000) {
    this.readyState = 3
    this.closes.push(code)
    this.onclose?.(Object.assign(new Event('close'), { code, reason: '', wasClean: true }))
  }
}

let server: HouseholdServer
let backend: RemoteBackend
let sockets: Socket[]
const authenticated: Wire.EventAuthenticated = {
  type: 'authenticated',
  principal_id: USER,
  sequence: 10,
  revision: 0,
}

beforeEach(async () => {
  server = new HouseholdServer()
  await server.start()
  sockets = []
  backend = new RemoteBackend({
    baseUrl: server.baseUrl,
    acknowledgeInsecureHttp: true,
    socketFactory: (url, protocol) => {
      const socket = new Socket(url, protocol)
      sockets.push(socket)
      return socket
    },
  })
  await backend.api.beginLogin('owner', 'long-unit-password').send()
})
afterEach(async () => {
  backend.dispose()
  await server.stop()
  vi.useRealTimers()
})

async function connected() {
  expect(await backend.connect()).toEqual({ status: 'ok', data: null })
  const socket = sockets[0]
  socket.open()
  socket.receive(authenticated)
  await vi.waitFor(() =>
    expect(backend.connection).toMatchObject({ coherent: true, eventSequence: 10 })
  )
  return socket
}

describe('first-frame authenticated invalidation protocol (socket unit tier)', () => {
  it('reconnects with only the fully processed sequence in the authentication frame', async () => {
    const socket = await connected()
    socket.close(1006)
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2500 })
    const replacement = sockets[1]
    replacement.open()
    expect(parseWire('EventClientFrame', parseJson(replacement.sent[0]))).toEqual({
      type: 'authenticate',
      token: server.bearer,
      after_sequence: 10,
    })
    expect(new URL(replacement.url).search).toBe('')
    server.vault.revision = 1
    replacement.receive({ ...authenticated, sequence: 12, revision: 1 })
    await vi.waitFor(() =>
      expect(backend.connection).toMatchObject({ coherent: true, revision: 1, eventSequence: 12 })
    )
  })

  it('honors server Retry-After instead of repeatedly resyncing and reconnecting into a rate limit', async () => {
    const socket = await connected()
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    server.custom = (_request, response) => {
      response.setHeader('Retry-After', '7')
      server.json(response, 429, {
        error: { code: 'rate_limited', message: 'Read budget exhausted' },
      })
      return true
    }
    const before = server.requests.length
    socket.receive({ type: 'vault_changed', sequence: 11, revision: 1, cause: 'commit' })
    await vi.waitFor(() => expect(socket.closes).toContain(4000))
    expect(timeout.mock.calls.some((args) => args[1] === 7000)).toBe(true)
    expect(server.requests.length - before).toBe(1)
    timeout.mockRestore()
  })

  it('never sends credentials in URL/subprotocol, and first connection fully resyncs', async () => {
    const socket = await connected()
    const url = new URL(socket.url)
    expect(url.pathname).toBe('/api/v1/events')
    expect(url.search).toBe('')
    expect(url.hash).toBe('')
    expect(socket.protocol).toBe('openhome.events.v1')
    expect(parseWire('EventClientFrame', parseJson(socket.sent[0]))).toEqual({
      type: 'authenticate',
      token: server.bearer,
    })
    expect(socket.url).not.toContain(server.bearer)
    expect(server.requests.filter((request) => request.path === '/api/v1/vault')).toHaveLength(2)
    expect(server.requests.filter((request) => request.path === '/api/v1/pokemon')).toHaveLength(2)
  })

  it('resyncs a retention gap and retains staged edits for deliberate rebase', async () => {
    const socket = await connected()
    await backend.startTransaction()
    await backend.setTheme('dark')
    server.vault.revision = 2
    server.vault.content.banks[0].name = 'Other owner session'
    socket.receive({ type: 'resync_required', sequence: 300, revision: 2, reason: 'retention_gap' })
    await vi.waitFor(() =>
      expect(backend.connection).toMatchObject({
        revision: 2,
        eventSequence: 300,
        coherent: true,
        editing: true,
        conflicted: true,
      })
    )
    const draft = await backend.getVault()
    expect(draft.status === 'ok' && draft.data.content.settings.theme).toBe('dark')
    expect(draft.status === 'ok' && draft.data.revision).toBe(0)
  })

  it('does not expose a coherent cache before buffered invalidations have been reconciled', async () => {
    const socket = await connected()
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
    const coherentRevisions: (number | undefined)[] = []
    const unsubscribe = backend.subscribe(() => {
      if (backend.connection.coherent) coherentRevisions.push(backend.connection.revision)
    })
    socket.receive({ type: 'vault_changed', sequence: 11, revision: 0, cause: 'commit' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(backend.connection.coherent).toBe(false)
    server.vault.revision = 1
    server.vault.content.banks[0].name = 'Buffered change'
    socket.receive({ type: 'vault_changed', sequence: 12, revision: 1, cause: 'commit' })
    release?.()
    await vi.waitFor(() =>
      expect(backend.connection).toMatchObject({ coherent: true, eventSequence: 12, revision: 1 })
    )
    expect(coherentRevisions.every((revision) => revision === 1)).toBe(true)
    unsubscribe()
  })

  it('clears credentials, binaries and edits immediately on a revoked socket', async () => {
    const socket = await connected()
    await backend.loadHomeBanks()
    await backend.startTransaction()
    await backend.setTheme('dark')
    socket.close(4401)
    expect(backend.connection).toMatchObject({
      authenticated: false,
      editing: false,
      coherent: false,
      revision: undefined,
    })
    expect(await backend.getRecords()).toMatchObject({
      status: 'error',
      failure: { code: 'unauthorized' },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(sockets).toHaveLength(1)
  })

  it('rejects private frames before authentication instead of treating them as collection patches', async () => {
    await backend.connect()
    const socket = sockets[0]
    socket.open()
    socket.receive({ type: 'vault_changed', sequence: 1, revision: 0, cause: 'commit' })
    expect(socket.closes).toContain(4400)
    expect(backend.connection.eventSequence).toBeUndefined()
  })

  it('does not advance the replay cursor after a failed resync', async () => {
    const socket = await connected()
    server.custom = (_request, response) => {
      server.json(response, 503, { error: { code: 'storage_unavailable', message: 'Read failed' } })
      return true
    }
    socket.receive({ type: 'vault_changed', sequence: 99, revision: 1, cause: 'commit' })
    await vi.waitFor(() => expect(socket.closes).toContain(4000))
    expect(backend.connection.eventSequence).toBe(10)
    expect(backend.connection.coherent).toBe(false)
  })

  it('closes after two missed heartbeats and accepts only matching pong nonces', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const socket = await connected()
    vi.advanceTimersByTime(30_000)
    expect(parseJson(socket.sent.at(-1) ?? '')).toEqual({ type: 'ping', nonce: 1 })
    socket.receive({ type: 'pong', nonce: 1 })
    vi.advanceTimersByTime(90_000)
    expect(socket.closes).toContain(4000)
  })
})
