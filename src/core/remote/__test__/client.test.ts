// @vitest-environment node
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteClient } from '../client'
import { decodeBytes, newBearer, newId, pokemonInput, sha256 } from '../crypto'
import { parseJson, parseWire } from '../validation'
import { HouseholdServer, id, USER } from './support'
import type * as Wire from '../wire-types'

let server: HouseholdServer
beforeEach(async () => {
  server = new HouseholdServer()
  await server.start()
})
afterEach(async () => {
  await server.stop()
  vi.unstubAllGlobals()
})

const client = () => new RemoteClient({ baseUrl: server.baseUrl, acknowledgeInsecureHttp: true })

describe('opaque credentials and fixed v1 HTTP requests', () => {
  it('does not reactivate or report a cleared successful exchange as a fresh login', async () => {
    const api = client()
    const exchange = api.beginLogin('owner', 'long-unit-password')
    await Promise.all([exchange.send(), exchange.send()])
    expect(server.requests).toHaveLength(1)
    api.clearCredentials()
    await expect(exchange.send()).rejects.toMatchObject({ code: 'cancelled' })
    expect(api.authenticated).toBe(false)
  })

  it('keeps acknowledged outcomes intact when a client mutation observer throws', async () => {
    const api = client()
    await api.beginLogin('owner', 'long-unit-password').send()
    server.custom = (request, response) => {
      if (request.path !== '/api/v1/pairing/codes') return false
      server.json(response, 201, {
        id: id(20),
        generation: 1,
        code: '001234',
        expires_at: '2026-11-17T10:05:00Z',
        attempts_remaining: 10,
      } satisfies Wire.PairingCode)
      return true
    }
    api.subscribeMutations(() => {
      throw new Error('Client observer bug')
    })
    expect((await api.call('createPairingCode', { body: {} })).data.code).toBe('001234')
    expect(api.observerError).toMatchObject({ code: 'internal_error' })
    expect(server.requests).toHaveLength(2)
  })

  it('creates a CSPRNG bearer before login and retains the identical exchange after a lost response', async () => {
    // Login receipts intentionally contain no raw token. Generating it after login cannot work.
    const api = client()
    let drop = true
    server.custom = (request, response) => {
      if (request.path !== '/api/v1/auth/login' || !drop) return false
      drop = false
      response.destroy()
      return true
    }
    const attempt = api.beginLogin('owner', 'long-unit-password')
    await expect(attempt.send()).rejects.toMatchObject({ code: 'network_error', uncertain: true })
    expect(api.authenticated).toBe(false)
    const response = await attempt.send()
    const first = server.requests[0]
    const second = server.requests[1]
    const body = parseWire('LoginRequest', first.body)
    expect(body.token).toMatch(/^ohs_[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(body.token.slice(4), 'base64url')).toHaveLength(32)
    expect(second.text).toBe(first.text)
    expect(second.headers['idempotency-key']).toBe(first.headers['idempotency-key'])
    expect(response.data).not.toHaveProperty('token')
    await api.call('getStatus', {})
    expect(server.requests[2].headers.authorization).toBe(`Bearer ${body.token}`)
    expect(first.headers.authorization).toBeUndefined()
    expect(server.requests.every((request) => request.query.size === 0)).toBe(true)
  })

  it('creates a separate random device candidate before claim, with no token expected in the grant', async () => {
    const api = client()
    server.custom = (request, response) => {
      if (request.path !== '/api/v1/pairing/claim') return false
      parseWire('PairClaimRequest', request.body)
      server.json(response, 201, {
        user: { id: USER, username: 'owner', role: 'member' },
        device: {
          id: id(90),
          name: 'Console',
          created_at: '2026-11-17T10:00:00Z',
          expires_at: '2027-02-15T10:00:00Z',
          revoked_at: null,
        },
        vault_revision: 0,
      } satisfies Wire.DeviceGrant)
      return true
    }
    const response = await api.beginClaim('owner', '001234', 'Console').send()
    const body = parseWire('PairClaimRequest', server.requests[0].body)
    expect(api.eventAuthentication().token).toBe(body.token)
    expect(response.data).not.toHaveProperty('token')
    expect(server.requests[0].text).toContain('"code":"001234"')
  })

  it('uses explicit empty POST JSON and bodyless DELETE for authenticated pairing and revocation', async () => {
    const api = client()
    await api.beginLogin('owner', 'long-unit-password').send()
    server.custom = (request, response) => {
      if (request.path === '/api/v1/pairing/codes') {
        server.json(response, 201, {
          id: id(20),
          generation: 1,
          code: '001234',
          expires_at: '2026-11-17T10:05:00Z',
          attempts_remaining: 10,
        } satisfies Wire.PairingCode)
        return true
      }
      if (request.path === `/api/v1/devices/${id(21)}`) {
        server.json(response, 204, null)
        return true
      }
      return false
    }
    await api.call('createPairingCode', { body: {} })
    await api.call('revokeDevice', { path: { device_id: id(21) } })
    expect(server.requests[1]).toMatchObject({ method: 'POST', text: '{}' })
    expect(server.requests[2]).toMatchObject({ method: 'DELETE', text: '' })
    for (const request of server.requests.slice(1)) {
      expect(request.headers.authorization).toBe(`Bearer ${server.bearer}`)
      expect(parseWire('Id', request.headers['idempotency-key'])).toBeTruthy()
    }
  })

  it('refuses HTTP until it has an explicit, observable insecure-LAN acknowledgement', async () => {
    const api = new RemoteClient({ baseUrl: server.baseUrl })
    expect(api.transportSecurity).toBe('insecure-http-unacknowledged')
    const login = api.beginLogin('owner', 'long-unit-password')
    await expect(login.send()).rejects.toMatchObject({ code: 'insecure_transport' })
    expect(server.requests).toHaveLength(0)
    api.acknowledgeInsecureHttp()
    expect(api.transportSecurity).toBe('insecure-http-acknowledged')
    await login.send()
    expect(server.requests).toHaveLength(1)
  })

  it('rejects credentials/query/paths in the server origin and invalid strong preconditions before fetch', () => {
    for (const baseUrl of [
      'https://owner:secret@example.invalid',
      `${server.baseUrl}/api/v1`,
      `${server.baseUrl}/?token=secret`,
    ]) {
      expect(() => new RemoteClient({ baseUrl })).toThrow()
    }
    const api = client()
    for (const ifMatch of ['W/"vault-0"', '*', '"vault-9007199254740992"', '"trade-0"']) {
      expect(() => parseWire('VaultETag', ifMatch)).toThrow()
    }
    expect(() =>
      api.prepare('commitVault', {
        ifMatch: '"vault-9007199254740992"',
        body: {
          mode: 'delta',
          commands: [{ op: 'pokemon_place', pokemon_id: id(3), destination: null }],
        },
      })
    ).toThrow()
    expect(() => api.prepare('listPokemon', { query: { form: 1 } })).toThrow('requires species')
    expect(() => api.prepare('getVault', { query: { view: 'summary', bank_id: id(1) } })).toThrow(
      'require box view'
    )
    expect(server.requests).toHaveLength(0)
  })

  it('propagates actual typed HTTP errors and Retry-After without mistaking error JSON for data', async () => {
    const api = client()
    await api.beginLogin('owner', 'long-unit-password').send()
    server.custom = (_request, response) => {
      response.setHeader('Retry-After', '7')
      server.json(response, 503, {
        error: { code: 'engine_unavailable', message: 'Save worker is not ready' },
      })
      return true
    }
    await expect(api.call('getStatus', {})).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: 'Save worker is not ready',
      httpStatus: 503,
      retryAfterSeconds: 7,
      uncertain: false,
    })
  })

  it('clears credentials on logout failure too, without claiming server revocation succeeded', async () => {
    const api = client()
    await api.beginLogin('owner', 'long-unit-password').send()
    server.custom = (request, response) => {
      if (request.path !== '/api/v1/auth/logout') return false
      response.destroy()
      return true
    }
    await expect(api.logout()).rejects.toMatchObject({ code: 'network_error' })
    expect(api.authenticated).toBe(false)
    expect(() => api.eventAuthentication()).toThrow('Authentication failed')
  })
})

describe('strict response and byte guards', () => {
  it('accepts the full 16 MiB save envelope without overflowing the regexp stack and still rejects broken padding', () => {
    // Real save limits exceed V8's stack budget for the schema's quartet-group regex.
    const encoded = 'A'.repeat(22_369_620) + 'AA=='
    expect(parseWire('SaveBase64', encoded).length).toBe(encoded.length)
    for (const invalid of ['AAAA=AAA', 'AAA=====', 'A===', 'AA=_', 'AAA']) {
      expect(() => parseWire('SaveBase64', invalid)).toThrow()
    }
  })

  it.each([
    '{"status":"alive","status":"alive"}',
    '{"status":"alive","extra":true}',
    '{"status":"alive","__proto__":{}}',
    '{"status":"alive"} trailing',
    '{"status":"\\ud800"}',
    '{"status":NaN}',
  ])('does not silently accept malformed or unknown wire content: %s', async (body) => {
    const api = client()
    server.custom = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(body)
      return true
    }
    await expect(api.call('health', {})).rejects.toMatchObject({ code: 'protocol_error' })
  })

  it('checks canonical binary padding, length and SHA-256 independently', () => {
    const original = server.pokemon.output
    expect(decodeBytes(original)).toEqual(server.pokemon.binary)
    expect(() => decodeBytes({ ...original, byte_length: original.byte_length - 1 })).toThrow(
      'incorrect length'
    )
    expect(() => decodeBytes({ ...original, sha256: '0'.repeat(64) })).toThrow('SHA-256')
    expect(() => decodeBytes({ ...original, data_base64: ` ${original.data_base64}` })).toThrow(
      'noncanonical'
    )
    expect(parseWire('PkmInput', pokemonInput(server.pokemon.original, 'pk8')).sha256).toBe(
      sha256(server.pokemon.original)
    )
  })

  it('uses strong CSPRNG UUID/token generation and existing SHA fallback without subtle or randomUUID', () => {
    // Explicit HTTP LAN is intentionally supported, but must never fall back to Math.random.
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
    const first = newBearer()
    expect(newBearer()).not.toBe(first)
    expect(parseWire('Id', newId())).toBeTruthy()
    expect(sha256(server.pokemon.original)).toBe(
      createHash('sha256').update(server.pokemon.original).digest('hex')
    )
    vi.stubGlobal('crypto', undefined)
    expect(() => newBearer()).toThrow('CSPRNG')
    expect(() => newId()).toThrow('CSPRNG')
  })

  it('does not turn a mismatched ETag or non-JSON success into a valid cached read', async () => {
    const api = client()
    await api.beginLogin('owner', 'long-unit-password').send()
    server.custom = (_request, response) => {
      server.json(response, 200, server.vault, 1)
      return true
    }
    await expect(api.call('getVault', {})).rejects.toMatchObject({
      code: 'protocol_error',
      message: 'Response ETag does not match its revision',
    })
    server.custom = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>proxy login</html>')
      return true
    }
    await expect(api.call('health', {})).rejects.toMatchObject({
      code: 'protocol_error',
      message: 'Expected an application/json response',
    })
    expect(() => parseJson('{"value":1e9999}')).toThrow()
  })
})
