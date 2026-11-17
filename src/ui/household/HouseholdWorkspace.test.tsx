import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { initialVault, record } from '@openhome-core/remote/__test__/support'
import { parseWire } from '@openhome-core/remote'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HouseholdWorkspace from './HouseholdWorkspace'
import { WorkspaceFixture, clickReady, id, POKEMON } from './testing'
import type { RemoteBackend } from '@openhome-core/remote'

describe('household collection user workflows (typed HTTP fixture, not service E2E)', () => {
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
  const commits = () =>
    fixture.requests.filter((request) => request.path === '/api/v1/vault/commit')
  const ready = async () => {
    await screen.findByRole('grid', { name: /30 slots/ })
  }

  it('renders exactly 30 real slots, stages placement by server UUID, and replays one uncertain save unchanged', async () => {
    const duplicate = record(fixture.pokemon.observed, id(10))
    duplicate.original_artifact_ids = [id(11)]
    duplicate.ohpkm_artifact_id = id(12)
    fixture.records.push(duplicate)
    fixture.vault = initialVault(fixture.records)
    fixture.vault.content.banks[0].boxes[0].slots[1] = duplicate.id
    render(<HouseholdWorkspace backend={backend} />)
    await ready()
    const grid = screen.getByRole('grid')
    const slots = within(grid).getAllByRole('button')
    const save = screen.getByRole('button', { name: 'Save changes' })
    const rollback = screen.getByRole('button', { name: 'Roll back staged changes' })
    expect(slots).toHaveLength(30)
    expect(slots[0]).toHaveAccessibleName(/^Slot 1:/)
    expect(slots[1]).toHaveAccessibleName(/^Slot 2:/)
    expect(slots[2]).toHaveAccessibleName(/^Slot 3: empty/)
    expect(slots[6]).toHaveAccessibleName(/^Slot 7:/)
    await clickReady(slots[0])
    await screen.findByText(fixture.pokemon.identifier)
    await clickReady(slots[1])
    expect(backend.connection.editing).toBe(false)
    await clickReady(slots[0])
    fireEvent.keyDown(slots[0], { key: 'ArrowDown' })
    expect(slots[6]).toHaveFocus()
    await clickReady(slots[2])
    await waitFor(() => expect(backend.connection.editing).toBe(true))
    expect(fixture.vault.content.banks[0].boxes[0].slots[0]).toBe(POKEMON)
    expect(commits()).toHaveLength(0)
    fixture.dropNextCommit = true
    await clickReady(save)
    await waitFor(() => expect(save).toHaveAccessibleName('Retry exact save'))
    expect(rollback).toBeDisabled()
    expect(fixture.vault.content.banks[0].boxes[0].slots.slice(0, 3)).toEqual([
      null,
      duplicate.id,
      POKEMON,
    ])
    await clickReady(save)
    await waitFor(() => expect(backend.connection.editing).toBe(false))
    expect(commits()).toHaveLength(2)
    expect(commits()[1].text).toBe(commits()[0].text)
    expect(commits()[1].headers['idempotency-key']).toBe(commits()[0].headers['idempotency-key'])
    expect(commits()[1].headers['if-match']).toBe('"vault-0"')
    expect(parseWire('VaultCommitRequest', commits()[0].body)).toEqual({
      mode: 'delta',
      commands: [
        {
          op: 'pokemon_place',
          pokemon_id: POKEMON,
          destination: {
            bank_id: fixture.vault.content.banks[0].id,
            box_id: fixture.vault.content.banks[0].boxes[0].id,
            slot: 2,
          },
        },
      ],
    })
    expect(fixture.vault.revision).toBe(1)
  })

  it('rolls back local placement without HTTP and never disposes the parent backend on unmount', async () => {
    const dispose = vi.spyOn(backend, 'dispose')
    const stopEvents = vi.spyOn(backend, 'stopEvents')
    const view = render(<HouseholdWorkspace backend={backend} />)
    await ready()
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await clickReady(screen.getByRole('button', { name: /^Slot 2: empty/ }))
    await waitFor(() => expect(backend.connection.editing).toBe(true))
    await clickReady(screen.getByRole('button', { name: 'Roll back staged changes' }))
    await waitFor(() => expect(backend.connection.editing).toBe(false))
    expect(fixture.vault.content.banks[0].boxes[0].slots[0]).toBe(POKEMON)
    expect(commits()).toHaveLength(0)
    view.unmount()
    expect(dispose).not.toHaveBeenCalled()
    expect(stopEvents).not.toHaveBeenCalled()
  })

  it('persists favorites/labels, uses supported server search/metadata, and retains legacy history', async () => {
    const bank = fixture.vault.content.banks[0]
    fixture.vault.content.openhome_compatibility = {
      version: 1,
      current_bank: 0,
      banks: [
        {
          bank_id: bank.id,
          folder_id: id(50),
          index: 0,
          source_name: null,
          current_box: 0,
          boxes: [{ box_id: bank.boxes[0].id, folder_id: id(51), index: 0, source_name: null }],
        },
      ],
      pokedex_history: [
        { species: 25, form: 0, level: 'Caught', games: [], extra: [], flags: [], shiny_leaves: 0 },
      ],
    }
    const history = structuredClone(fixture.vault.content.openhome_compatibility.pokedex_history)
    render(<HouseholdWorkspace backend={backend} />)
    await ready()
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await clickReady(await screen.findByRole('button', { name: '☆ Favorite' }))
    await screen.findByRole('button', { name: '★ Remove favorite' })
    fireEvent.change(screen.getByLabelText('New label'), { target: { value: 'family' } })
    await clickReady(screen.getByRole('button', { name: 'Stage label' }))
    await screen.findByRole('button', { name: 'Remove label family' })
    await clickReady(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(backend.connection.editing).toBe(false))
    expect(fixture.records[0].metadata).toEqual({
      pokemon_id: POKEMON,
      favorite: true,
      tags: ['family'],
    })
    expect(fixture.vault.content.openhome_compatibility?.pokedex_history).toEqual(history)
    const commit = parseWire('VaultCommitRequest', commits()[0].body)
    expect(
      commit.mode === 'delta' && commit.commands.every((command) => command.op === 'metadata_put')
    ).toBe(true)
    const searchText = screen.getByLabelText('Nickname or label')
    await waitFor(() => expect(searchText).toBeEnabled())
    fireEvent.change(searchText, { target: { value: 'family' } })
    fireEvent.change(screen.getByLabelText('Exact label'), { target: { value: 'family' } })
    await clickReady(screen.getByLabelText('Favorites only'))
    fireEvent.change(screen.getByLabelText('Species ID'), {
      target: { value: String(fixture.pokemon.observed.species) },
    })
    fireEvent.change(screen.getByLabelText('Form ID'), {
      target: { value: String(fixture.pokemon.observed.form) },
    })
    await clickReady(screen.getByRole('button', { name: 'Search saved collection' }))
    await screen.findByText(/1 results loaded/)
    const query = fixture.requests
      .filter((request) => request.path === '/api/v1/pokemon' && request.query.has('q'))
      .at(-1)?.query
    expect(Object.fromEntries(query ?? [])).toMatchObject({
      q: 'family',
      tag: 'family',
      favorite: 'true',
      species: String(fixture.pokemon.observed.species),
      form: String(fixture.pokemon.observed.form),
      at_revision: '1',
    })
    await clickReady(screen.getByRole('button', { name: 'Observed trackers' }))
    await screen.findByText(/1 favorites/)
    expect(
      fixture.requests.some(
        (request) => request.path === '/api/v1/metadata' && request.query.get('at_revision') === '1'
      )
    ).toBe(true)
    expect(screen.getByText(/not official HOME completion/)).toBeVisible()
  })

  it('requires explicit rebase and preserves an unrelated concurrent bank rename', async () => {
    render(<HouseholdWorkspace backend={backend} />)
    await ready()
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await clickReady(screen.getByRole('button', { name: /^Slot 2: empty/ }))
    await waitFor(() => expect(backend.connection.editing).toBe(true))
    fixture.vault.revision++
    fixture.vault.content.banks[0].name = 'Another member device'
    await clickReady(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('heading', { name: 'Review and rebase' })
    await clickReady(screen.getByRole('button', { name: 'Refresh server' }))
    await waitFor(() => expect(backend.connection.revision).toBe(1))
    const rebase = screen.getByRole('button', { name: 'Rebase reviewed edits' })
    expect(rebase).toBeDisabled()
    await clickReady(screen.getByLabelText(/I reviewed the staged and current revisions/))
    await clickReady(rebase)
    await waitFor(() => expect(backend.connection.conflicted).toBe(false))
    expect(commits()).toHaveLength(1)
    await clickReady(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(backend.connection.editing).toBe(false))
    expect(fixture.vault.content.banks[0].name).toBe('Another member device')
    expect(fixture.vault.content.banks[0].boxes[0].slots[1]).toBe(POKEMON)
    expect(commits()[1].headers['idempotency-key']).not.toBe(
      commits()[0].headers['idempotency-key']
    )
    expect(commits()[1].headers['if-match']).toBe('"vault-1"')
  })

  it('creates an actual 30-slot box and renames a bank without dropping its occupied slots', async () => {
    render(<HouseholdWorkspace backend={backend} />)
    await ready()
    await clickReady(screen.getByText('Manage banks and boxes'))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Nursery' } })
    await clickReady(screen.getByRole('button', { name: 'Stage creation' }))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Nursery' })).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Bank name'), {
      target: { value: 'My household collection' },
    })
    await clickReady(screen.getByRole('button', { name: 'Stage bank rename' }))
    await clickReady(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fixture.vault.revision).toBe(1))
    expect(fixture.vault.content.banks[0].name).toBe('My household collection')
    expect(fixture.vault.content.banks[0].boxes[0].slots[0]).toBe(POKEMON)
    const created = fixture.vault.content.banks[0].boxes.find((box) => box.name === 'Nursery')
    expect(created?.slots).toEqual(Array.from({ length: 30 }, () => null))
    expect(commits()).toHaveLength(1)
  })

  it('clears private collection state on an actual authenticated 401 read', async () => {
    render(<HouseholdWorkspace backend={backend} />)
    await ready()
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await screen.findByText(fixture.pokemon.identifier)
    fixture.forceUnauthorized = true
    await clickReady(screen.getByRole('button', { name: 'Refresh server' }))
    await screen.findByText(/Previous working state has been cleared/)
    expect(screen.queryByText(fixture.pokemon.identifier)).not.toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('clears private UI on credential loss and rejects an old delayed binary callback after a new login', async () => {
    const original = fixture.custom
    let release: (() => void) | undefined
    let delayed = false
    fixture.custom = async (request, response) => {
      if (!delayed && request.path.endsWith('/export')) {
        delayed = true
        const output = {
          revision: fixture.vault.revision,
          output: fixture.pokemon.output,
          losses: [],
        }
        await new Promise<void>((ready) => {
          release = ready
        })
        fixture.json(response, 200, output, output.revision)
        return true
      }
      return (await original?.(request, response)) ?? false
    }
    render(<HouseholdWorkspace backend={backend} />)
    await ready()
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    act(() => backend.api.clearCredentials())
    expect(screen.getByText(/Previous working state has been cleared/)).toBeVisible()
    fixture.records = []
    fixture.vault = initialVault([])
    await act(async () => {
      await backend.api.beginLogin('second', 'another-unit-password').send()
    })
    await screen.findByText(/Your vault is empty/)
    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    expect(screen.queryByText(fixture.pokemon.identifier)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Slot 1:.*, level/ })).not.toBeInTheDocument()
  })
})
