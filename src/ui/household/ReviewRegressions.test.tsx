import {
  type Input,
  type Operation,
  type RemoteBackend,
  type RemoteClient,
  type Trade,
  parseWire,
} from '@openhome-core/remote'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HouseholdWorkspace from './HouseholdWorkspace'
import { clickReady, id, USER, WorkspaceFixture } from './testing'

function signal() {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, resolve: () => release?.() }
}

function observeNextCall(backend: RemoteBackend, watched: Operation) {
  const original: RemoteClient['call'] = backend.api.call.bind(backend.api)
  let pending: ReturnType<typeof signal> | undefined
  const observe: RemoteClient['call'] = async <N extends Operation>(
    operation: N,
    input: Input<N>
  ) => {
    const completion = operation === watched ? pending : undefined
    if (completion) pending = undefined
    try {
      return await original(operation, input)
    } finally {
      completion?.resolve()
    }
  }
  vi.spyOn(backend.api, 'call').mockImplementation(observe)
  return () => {
    pending = signal()
    return pending.promise
  }
}

describe('household review regressions (scheduled HTTP fixtures, not service E2E)', () => {
  let fixture: WorkspaceFixture
  let backend: RemoteBackend
  const releases = new Set<() => void>()
  beforeEach(async () => {
    fixture = new WorkspaceFixture()
    backend = await fixture.login()
  })
  afterEach(async () => {
    await act(async () => {
      releases.forEach((release) => release())
      releases.clear()
    })
    cleanup()
    await fixture.close()
    vi.restoreAllMocks()
  })

  it('review regression: a cancelled room A read cannot replace newly acknowledged room B', async () => {
    const original = fixture.custom
    const held = signal()
    const heldB = signal()
    releases.add(held.resolve)
    releases.add(heldB.resolve)
    const watchRead = observeNextCall(backend, 'getTrade')
    const roomB: Trade = {
      ...structuredClone(fixture.trade),
      id: id(180),
      revision: 0,
      offer_version: 0,
      participants: [
        {
          user: { id: USER, username: 'owner', role: 'admin' },
          offer: [],
          confirmed_offer_version: null,
        },
      ],
    }
    const codeB = 'BCDEFGHJKM23'
    let creates = 0
    let holdA = false
    let captured = false
    let capturedB = false
    fixture.custom = async (request, response) => {
      if (request.path === '/api/v1/trades' && request.method === 'POST' && ++creates === 2) {
        response.setHeader('ETag', '"trade-0"')
        fixture.json(response, 201, { trade: roomB, join_code: codeB })
        return true
      }
      if (request.path === `/api/v1/trades/${fixture.tradeId}` && holdA) {
        const stale = structuredClone(fixture.trade)
        captured = true
        await held.promise
        response.setHeader('ETag', `"trade-${stale.revision}"`)
        fixture.json(response, 200, { trade: stale })
        return true
      }
      if (request.path === `/api/v1/trades/${roomB.id}`) {
        capturedB = true
        await heldB.promise
        response.setHeader('ETag', '"trade-0"')
        fixture.json(response, 200, { trade: roomB })
        return true
      }
      return (await original?.(request, response)) ?? false
    }
    render(<HouseholdWorkspace backend={backend} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: 'Household trade' }))
    const create = screen.getByRole('button', { name: 'Create trade room' })
    await clickReady(create)
    await screen.findByText(fixture.joinCode)
    await clickReady(screen.getByRole('button', { name: 'Cancel trade room' }))
    await screen.findByRole('heading', { name: 'CANCELLED' })
    await waitFor(() => expect(create).toBeEnabled())
    holdA = true
    const delivered = watchRead()
    await clickReady(screen.getByRole('button', { name: 'Refresh room' }))
    await waitFor(() => expect(captured).toBe(true))
    await clickReady(create)
    await screen.findByText(codeB)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel trade room' })).toBeEnabled()
    )
    const refreshRoom = screen.getByRole('button', { name: 'Refresh room' })
    const deliveredB = watchRead()
    await clickReady(refreshRoom)
    await waitFor(() => expect(capturedB).toBe(true))
    await act(async () => {
      held.resolve()
      await delivered
    })
    expect(screen.getByRole('heading', { name: 'WAITING' })).toBeVisible()
    expect(screen.getByText(roomB.id)).toBeVisible()
    expect(screen.getByText(codeB)).toBeVisible()
    expect(refreshRoom).toBeDisabled()
    await act(async () => {
      heldB.resolve()
      await deliveredB
    })
    await waitFor(() => expect(refreshRoom).toBeEnabled())
    await waitFor(() =>
      expect(
        fixture.requests.some((request) => request.path === `/api/v1/trades/${roomB.id}`)
      ).toBe(true)
    )
    expect(screen.getByRole('heading', { name: 'WAITING' })).toBeVisible()
  })

  it('review regression: unsent join and COPY upload drafts guard navigation until explicitly cleared', async () => {
    const guard = vi.fn<(pending: boolean) => void>()
    render(<HouseholdWorkspace backend={backend} onPendingChange={guard} />)
    await screen.findByRole('grid')
    await waitFor(() => expect(guard).toHaveBeenLastCalledWith(false))
    await clickReady(screen.getByRole('button', { name: 'Household trade' }))
    const join = screen.getByLabelText('Trade join code')
    await act(async () => {
      fireEvent.change(join, { target: { value: fixture.joinCode } })
    })
    const joinPending = guard.mock.lastCall?.[0]
    await act(async () => {
      fireEvent.change(join, { target: { value: '' } })
    })
    await clickReady(screen.getByRole('button', { name: 'Import / save workbench' }))
    fireEvent.change(screen.getByLabelText('PKM or OHPKM file'), {
      target: { files: [new File([fixture.pokemon.original], 'retained-copy.pk8')] },
    })
    await screen.findByText('retained-copy.pk8')
    const copy = screen.getByRole('button', { name: 'COPY file into vault' })
    await waitFor(() => expect(copy).toBeEnabled())
    const uploadPending = guard.mock.lastCall?.[0]
    expect({ join: joinPending, upload: uploadPending }).toEqual({ join: true, upload: true })
    expect(backend.connection.editing).toBe(false)
    expect(fixture.requests.some((request) => request.path === '/api/v1/pokemon/import')).toBe(
      false
    )
    await clickReady(screen.getByRole('button', { name: 'Discard PKM COPY draft' }))
    await waitFor(() => expect(guard).toHaveBeenLastCalledWith(false))
    expect(screen.queryByText('retained-copy.pk8')).not.toBeInTheDocument()
    await clickReady(screen.getByRole('button', { name: 'Household trade' }))
    await act(async () => {
      fireEvent.change(join, { target: { value: fixture.joinCode } })
    })
    await clickReady(screen.getByRole('button', { name: 'Discard join draft' }))
    expect(join).toHaveValue('')
    await waitFor(() => expect(guard).toHaveBeenLastCalledWith(false))
  })

  it('review regression: delayed converted bytes cannot restore a preview after target or consent changes', async () => {
    const download = vi.spyOn(backend.files, 'saveLocalFile').mockResolvedValue(null)
    const original = fixture.custom
    let held: ReturnType<typeof signal> | undefined
    let requests = 0
    fixture.custom = async (request, response) => {
      if (request.path.endsWith('/export')) {
        const body = parseWire('PokemonExportRequest', request.body)
        if (body.representation === 'converted' && held) {
          requests++
          await held.promise
        }
      }
      return (await original?.(request, response)) ?? false
    }
    render(<HouseholdWorkspace backend={backend} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await screen.findByText(fixture.pokemon.identifier)
    const watchExport = observeNextCall(backend, 'exportPokemon')
    const target = screen.getByLabelText('Conversion target')
    const consent = screen.getByLabelText(/I explicitly allow lossy conversion for this Pokémon/)
    const preview = screen.getByRole('button', { name: 'Preview converted PKM' })
    const stale: boolean[] = []
    for (const change of ['target', 'consent'] as const) {
      await act(async () => {
        fireEvent.change(target, { target: { value: 'pk8' } })
      })
      if (!(consent instanceof HTMLInputElement)) throw new Error('Missing conversion consent')
      if (!consent.checked) await clickReady(consent)
      held = signal()
      releases.add(held.resolve)
      const delivered = watchExport()
      await clickReady(preview)
      await waitFor(() => expect(requests).toBe(stale.length + 1))
      if (change === 'target') {
        await act(async () => {
          fireEvent.change(target, { target: { value: 'pk5' } })
        })
      } else {
        await clickReady(consent)
      }
      expect(consent).not.toBeChecked()
      if (change === 'target') {
        await act(async () => {
          fireEvent.change(target, { target: { value: 'pk8' } })
        })
        await clickReady(consent)
        expect(consent).toBeChecked()
      }
      await act(async () => {
        held?.resolve()
        await delivered
      })
      await waitFor(() => expect(preview).toBeEnabled())
      stale.push(screen.queryByRole('button', { name: 'Download validated artifact' }) !== null)
    }
    expect(stale).toEqual([false, false])
    expect(screen.queryByText(/OHPKM-only metadata is not representable/)).not.toBeInTheDocument()
    expect(download).not.toHaveBeenCalled()
  })
})
