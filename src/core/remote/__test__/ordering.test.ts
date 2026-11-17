// @vitest-environment node
import type { ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteBackend } from '../backend'
import type * as Wire from '../wire-types'
import { HouseholdServer, id, status, USER } from './support'

let server: HouseholdServer
let backend: RemoteBackend
let releases: (() => void)[]
let observedBody: { path: string; started: () => void } | undefined

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  releases.push(resolve)
  return { promise, release: resolve }
}

function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
}

function value<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: string }): T {
  if (result.status === 'error') throw new Error(result.error)
  return result.data
}

const commits = () => server.requests.filter((request) => request.path === '/api/v1/vault/commit')

async function stream(
  response: ServerResponse,
  payload: unknown,
  until: Promise<void>,
  revision?: number
) {
  const text = JSON.stringify(payload)
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  if (revision !== undefined) response.setHeader('ETag', `"vault-${revision}"`)
  response.writeHead(200)
  response.flushHeaders()
  response.write(text.slice(0, 8))
  await until
  response.end(text.slice(8))
}

beforeEach(async () => {
  releases = []
  observedBody = undefined
  server = new HouseholdServer()
  await server.start()
  backend = new RemoteBackend({
    baseUrl: server.baseUrl,
    acknowledgeInsecureHttp: true,
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const observer = observedBody
      if (observer && new URL(url).pathname === observer.path && response.body) {
        observedBody = undefined
        // Backpressure makes this signal occur after the actual client starts reading
        // a real HTTP body, not merely after the fixture has written its headers.
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(chunk)
              observer.started()
            },
          })
        )
        return new Response(body, { status: response.status, headers: response.headers })
      }
      return response
    },
  })
  await backend.api.beginLogin('owner', 'long-unit-password').send()
})

afterEach(async () => {
  for (const release of releases) release()
  backend.dispose()
  await server.stop()
  vi.restoreAllMocks()
})

describe('receipt and credential ordering regressions', () => {
  it('Q1 retains uncertainty and frozen receipt identity through a failed replay until acknowledged', async () => {
    await backend.startTransaction()
    const checkpoint = value(await backend.checkpoint())
    await backend.setTheme('dark')
    server.dropNextCommit = true
    expect(await backend.commitTransaction()).toMatchObject({
      status: 'error',
      failure: { uncertain: true },
    })
    server.custom = (request, response) => {
      if (request.path !== '/api/v1/vault/commit') return false
      server.json(response, 503, {
        error: { code: 'storage_unavailable', message: 'Receipt storage unavailable' },
      })
      return true
    }
    expect(await backend.commitTransaction()).toMatchObject({
      status: 'error',
      failure: { code: 'storage_unavailable', httpStatus: 503, uncertain: true },
    })
    expect(backend.connection.uncertain).toBe(true)
    const merge = vi.fn((current: Wire.VaultContent) => current)
    for (const result of await Promise.all([
      backend.rollbackTransaction(),
      backend.rewind(checkpoint),
      backend.checkpoint(),
      backend.startTransaction(),
      backend.setTheme('light'),
      backend.stageContent(value(await backend.getVault()).content),
      backend.rebaseTransaction(merge),
      backend.saveSyncedState(),
    ])) {
      expect(result).toMatchObject({ status: 'error', failure: { code: 'uncertain_commit' } })
    }
    expect(merge).not.toHaveBeenCalled()
    server.custom = undefined
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(commits()).toHaveLength(3)
    for (const replay of commits().slice(1)) {
      expect(replay.text).toBe(commits()[0].text)
      expect(replay.headers['idempotency-key']).toBe(commits()[0].headers['idempotency-key'])
      expect(replay.headers['if-match']).toBe('"vault-0"')
    }
    expect(server.vault.revision).toBe(1)
    expect(server.vault.content.settings.theme).toBe('dark')
  })

  it('Q2 rechecks undo/checkpoint busy ownership after an await before an in-flight commit can be changed', async () => {
    await backend.startTransaction()
    await backend.setTheme('light')
    const checkpoint = value(await backend.checkpoint())
    await backend.setTheme('dark')
    server.dropNextCommit = true
    // Both helpers pass their initial ensureEdit check, then commit freezes its request.
    const undoing = backend.rewind(checkpoint)
    const checkpointing = backend.checkpoint()
    const saving = backend.commitTransaction()
    expect(await undoing).toMatchObject({ status: 'error', failure: { code: 'uncertain_commit' } })
    expect(await checkpointing).toMatchObject({
      status: 'error',
      failure: { code: 'uncertain_commit' },
    })
    expect(await saving).toMatchObject({ status: 'error', failure: { uncertain: true } })
    expect(value(await backend.getVault()).content.settings.theme).toBe('dark')
    expect(await backend.commitTransaction()).toEqual({ status: 'ok', data: null })
    expect(commits()).toHaveLength(2)
    expect(commits()[1].text).toBe(commits()[0].text)
    expect(commits()[1].headers['idempotency-key']).toBe(commits()[0].headers['idempotency-key'])
    expect(commits()[1].headers['if-match']).toBe(commits()[0].headers['if-match'])
    expect(server.vault.revision).toBe(1)
    expect(server.vault.content.settings.theme).toBe('dark')
  })

  it('Q3 fences private results and status cache publication when logout completes during a streamed body', async () => {
    const privateVault = structuredClone(server.vault)
    privateVault.content.banks[0].name = 'Previous owner private bank'
    const vaultRead = gate()
    const releaseVault = gate()
    observedBody = { path: '/api/v1/vault', started: vaultRead.release }
    server.custom = async (request, response) => {
      if (request.path !== '/api/v1/vault') return false
      await stream(response, privateVault, releaseVault.promise, privateVault.revision)
      return true
    }
    const previousVault = outcome(backend.api.call('getVault', {}))
    await vaultRead.promise
    await backend.api.logout()
    releaseVault.release()
    expect(await previousVault).toMatchObject({ error: { code: 'cancelled' } })
    expect(backend.api.authenticated).toBe(false)

    await backend.api.beginLogin('second', 'another-unit-password').send()
    const statusRead = gate()
    const releaseStatus = gate()
    observedBody = { path: '/api/v1/status', started: statusRead.release }
    server.custom = async (request, response) => {
      if (request.path !== '/api/v1/status') return false
      await stream(response, status, releaseStatus.promise)
      return true
    }
    const previousStatus = backend.resync()
    await statusRead.promise
    await backend.api.logout()
    expect(backend.connection.status).toBeUndefined()
    releaseStatus.release()
    expect(await previousStatus).toMatchObject({ status: 'error', failure: { code: 'cancelled' } })
    expect(backend.connection).toMatchObject({
      authenticated: false,
      coherent: false,
      status: undefined,
      revision: undefined,
    })
  })

  it('Q4 never publishes an old pinned read below a newer acknowledged commit floor', async () => {
    await backend.startTransaction()
    await backend.setTheme('dark')
    const pageCaptured = gate()
    const releasePage = gate()
    let captured = false
    server.custom = async (request, response) => {
      if (request.path !== '/api/v1/pokemon' || captured) return false
      captured = true
      const page: Wire.PokemonPage = {
        revision: server.vault.revision,
        items: structuredClone(server.records),
        next_cursor: null,
      }
      pageCaptured.release()
      await releasePage.promise
      server.json(response, 200, page, page.revision)
      return true
    }
    const published: { revision: number | undefined; floor: number }[] = []
    backend.subscribe(() => {
      const connection = backend.connection
      if (connection.coherent && connection.lastCommittedRevision !== undefined) {
        published.push({ revision: connection.revision, floor: connection.lastCommittedRevision })
      }
    })
    const oldResync = backend.resync()
    await pageCaptured.promise
    const saving = backend.commitTransaction()
    await vi.waitFor(() => expect(backend.connection.lastCommittedRevision).toBe(1))
    releasePage.release()
    expect(await saving).toEqual({ status: 'ok', data: null })
    expect(await oldResync).toMatchObject({ status: 'ok', data: { revision: 1 } })
    expect(published.length).toBeGreaterThan(0)
    expect(
      published.every(({ revision, floor }) => revision !== undefined && revision >= floor)
    ).toBe(true)
    expect(backend.connection).toMatchObject({
      coherent: true,
      revision: 1,
      lastCommittedRevision: 1,
    })
    expect(value(await backend.getVault()).content.settings.theme).toBe('dark')
  })

  it('Q5 cancels obsolete 401s and superseded login proofs without clearing a replacement session', async () => {
    const oldRead = gate()
    const releaseUnauthorized = gate()
    let intercepted = false
    server.custom = async (request, response) => {
      if (request.path !== '/api/v1/vault' || intercepted) return false
      intercepted = true
      oldRead.release()
      await releaseUnauthorized.promise
      server.json(response, 401, {
        error: { code: 'unauthorized', message: 'Authentication failed' },
      })
      return true
    }
    const obsolete = outcome(backend.api.call('getVault', {}))
    await oldRead.promise
    await backend.api.logout()
    await backend.api.beginLogin('replacement', 'another-unit-password').send()
    expect(await backend.resync()).toMatchObject({ status: 'ok' })
    const replacementGeneration = backend.api.generation
    releaseUnauthorized.release()
    expect(await obsolete).toMatchObject({ error: { code: 'cancelled' } })
    expect(backend.api.generation).toBe(replacementGeneration)
    expect(backend.api.eventAuthentication().token).toBe(server.bearer)
    expect(backend.connection).toMatchObject({ authenticated: true, coherent: true, revision: 0 })

    const proofRead = gate()
    const releaseOldProof = gate()
    server.custom = async (request, response) => {
      if (request.path !== '/api/v1/auth/login') return false
      proofRead.release()
      await releaseOldProof.promise
      server.json(response, 200, {
        user: { id: USER, username: 'older', role: 'admin' },
        session_id: id(90),
        expires_at: '2026-11-17T22:00:00Z',
        vault_revision: 0,
      } satisfies Wire.SessionGrant)
      return true
    }
    const older = outcome(backend.api.beginLogin('older', 'another-unit-password').send())
    await proofRead.promise
    const newer = backend.api.beginLogin('newer', 'another-unit-password')
    releaseOldProof.release()
    expect(await older).toMatchObject({ error: { code: 'cancelled' } })
    server.custom = undefined
    expect((await newer.send()).data.user.username).toBe('newer')
    expect(backend.api.eventAuthentication().token).toBe(server.bearer)
  })
})
