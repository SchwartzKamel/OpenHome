import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { parseWire, type RemoteBackend } from '@openhome-core/remote'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HouseholdWorkspace from './HouseholdWorkspace'
import { clickReady, POKEMON, WorkspaceFixture } from './testing'

describe('household trade consent and exact requests (not real-service E2E)', () => {
  let fixture: WorkspaceFixture
  let backend: RemoteBackend
  beforeEach(async () => {
    fixture = new WorkspaceFixture()
    backend = await fixture.login()
  })
  afterEach(async () => {
    cleanup()
    await fixture.close()
    vi.restoreAllMocks()
  })
  const actions = () => fixture.requests.filter((request) => request.path.endsWith('/actions'))
  const open = async () => {
    render(<HouseholdWorkspace backend={backend} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: 'Household trade' }))
  }

  it('shows both offers, retains an uncertain offer request, and invalidates consent after changed offers', async () => {
    await open()
    await clickReady(screen.getByRole('button', { name: 'Create trade room' }))
    await screen.findByText(fixture.joinCode)
    fixture.joinOther()
    await clickReady(screen.getByRole('button', { name: 'Refresh room' }))
    await screen.findByRole('region', { name: "other's current offer" })
    expect(
      within(screen.getByRole('region', { name: "other's current offer" })).getByText(
        fixture.foreignPokemon
      )
    ).toBeVisible()
    await clickReady(screen.getByRole('checkbox', { name: new RegExp(`^Offer .* ${POKEMON}$`) }))
    fixture.dropNextTradeAction = true
    await clickReady(screen.getByRole('button', { name: 'Submit my UUID offer' }))
    const retry = await screen.findByRole('button', { name: 'Retry exact request' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Confirm current offers' })).toBeDisabled()
    await clickReady(retry)
    await waitFor(() => expect(backend.connection.revision).toBe(1))
    await screen.findByText(/offer version 2/, { selector: '.hh-toolbar span' })
    expect(actions()).toHaveLength(2)
    expect(actions()[1].text).toBe(actions()[0].text)
    expect(actions()[1].headers['idempotency-key']).toBe(actions()[0].headers['idempotency-key'])
    expect(actions()[1].headers['if-match']).toBe('"trade-1"')
    expect(parseWire('TradeAction', actions()[0].body)).toEqual({
      action: 'offer',
      vault_if_match: '"vault-0"',
      pokemon_ids: [POKEMON],
    })
    await clickReady(screen.getByLabelText(/I reviewed both current offers/))
    await clickReady(screen.getByRole('button', { name: 'Confirm current offers' }))
    await screen.findByText('Confirmed offer version 2')
    expect(parseWire('TradeAction', actions()[2].body)).toEqual({
      action: 'confirm',
      vault_if_match: '"vault-1"',
      offer_version: 2,
    })
    expect(actions()[2].headers['if-match']).toBe('"trade-2"')
    fixture.changeOtherOffer()
    await clickReady(screen.getByRole('button', { name: 'Refresh room' }))
    await screen.findByText('Changed real summary')
    expect(screen.getByLabelText(/I reviewed both current offers/)).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Confirm current offers' })).toBeDisabled()
    await clickReady(screen.getByLabelText(/I reviewed both current offers/))
    await clickReady(screen.getByRole('button', { name: 'Confirm current offers' }))
    await screen.findByText('Confirmed offer version 3')
    expect(parseWire('TradeAction', actions()[3].body)).toEqual({
      action: 'confirm',
      vault_if_match: '"vault-1"',
      offer_version: 3,
    })
    expect(actions()[3].headers['if-match']).toBe('"trade-4"')
    expect(
      fixture.requests.some(
        (request) => request.path === `/api/v1/pokemon/${fixture.foreignPokemon}`
      )
    ).toBe(false)
    expect(fixture.records.map((item) => item.id)).toEqual([POKEMON])
    await clickReady(screen.getByRole('button', { name: 'Cancel trade room' }))
    await screen.findByRole('heading', { name: 'CANCELLED' })
    expect(parseWire('TradeAction', actions().at(-1)?.body)).toEqual({ action: 'cancel' })
  })

  it('joins by code and establishes its own participant from the actual join receipt', async () => {
    fixture.trade.participants[0].user = {
      id: fixture.otherUser,
      username: 'other',
      role: 'member',
    }
    await open()
    fireEvent.change(screen.getByLabelText('Trade join code'), {
      target: { value: fixture.joinCode },
    })
    await clickReady(screen.getByRole('button', { name: 'Join trade room' }))
    await screen.findByRole('heading', { name: 'owner (you)' })
    const join = fixture.requests.find((request) => request.path === '/api/v1/trades/join')
    expect(parseWire('TradeJoinRequest', join?.body)).toEqual({ join_code: fixture.joinCode })
    expect(join?.headers['idempotency-key']).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'other' })).toBeVisible()
  })
})
