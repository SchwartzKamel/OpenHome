import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { decodeBytes, parseWire, saveInput, type RemoteBackend } from '@openhome-core/remote'
import { sha256 } from '@openhome-core/remote/crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HouseholdWorkspace from './HouseholdWorkspace'
import { clickReady, id, ORIGINAL, POKEMON, WorkspaceFixture } from './testing'

describe('household import/export/transfer clicks (typed fixture, not engine/service E2E)', () => {
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
  const requests = (suffix: string) =>
    fixture.requests.filter((request) => request.path.endsWith(suffix))
  const start = async () => {
    render(<HouseholdWorkspace backend={backend} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: 'Import / save workbench' }))
  }
  const loadSave = async () => {
    fireEvent.change(screen.getByLabelText('Complete save file'), {
      target: { files: [new File([fixture.save], 'private-source.sav')] },
    })
    await screen.findByText('private-source.sav')
    await clickReady(screen.getByRole('button', { name: 'Inspect complete save' }))
    await screen.findByRole('checkbox', { name: 'Copy Box 1, slot 1' })
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Copy Box 1, slot 1' })).toBeEnabled()
    )
  }

  it('requires an explicit ambiguous PK4/PK5 hint, verifies SHA, and retries the same COPY without another record', async () => {
    const guard = vi.fn<(pending: boolean) => void>()
    render(<HouseholdWorkspace backend={backend} onPendingChange={guard} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: 'Import / save workbench' }))
    const bytes = decodeBytes(fixture.gen5.original)
    const input = screen.getByLabelText('PKM or OHPKM file')
    const dropzone = input.closest('.hh-upload')
    if (!dropzone) throw new Error('Missing accessible upload dropzone')
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File([bytes], 'not-a-format-proof.pk4')] },
    })
    await screen.findByText(/This byte length can be PK4 or PK5/)
    expect(screen.getByRole('button', { name: 'COPY file into vault' })).toBeDisabled()
    expect(requests('/pokemon/import')).toHaveLength(0)
    const formatHint = screen.getByLabelText('Validated format hint')
    await waitFor(() => expect(formatHint).toBeEnabled())
    fireEvent.change(formatHint, { target: { value: 'pk5' } })
    fireEvent.change(screen.getByLabelText('Expected SHA-256 (optional)'), {
      target: { value: '0'.repeat(64) },
    })
    expect(screen.getByRole('button', { name: 'COPY file into vault' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Expected SHA-256 (optional)'), {
      target: { value: fixture.gen5.original.sha256 },
    })
    fixture.dropNextImport = true
    await clickReady(screen.getByRole('button', { name: 'COPY file into vault' }))
    const retry = await screen.findByRole('button', { name: 'Retry exact request' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(fixture.copyCount).toBe(1)
    expect(screen.getByLabelText('PKM or OHPKM file')).toBeDisabled()
    expect(guard).toHaveBeenLastCalledWith(true)
    await clickReady(retry)
    await waitFor(() => expect(backend.connection.revision).toBe(1))
    await screen.findByText(/One Pokémon copied and retained unplaced/)
    const copies = requests('/pokemon/import')
    expect(copies).toHaveLength(2)
    expect(copies[1].text).toBe(copies[0].text)
    expect(copies[1].headers['idempotency-key']).toBe(copies[0].headers['idempotency-key'])
    expect(copies[1].headers['if-match']).toBe('"vault-0"')
    expect(parseWire('PokemonImportRequest', copies[0].body)).toEqual({
      kind: 'pkm',
      input: {
        data_base64: fixture.gen5.original.data_base64,
        sha256: fixture.gen5.original.sha256,
        format_hint: 'pk5',
      },
      destination: null,
    })
    expect(copies[0].text).not.toContain('not-a-format-proof')
    expect(fixture.copyCount).toBe(1)
    const acquired = fixture.records[1].id
    await clickReady(await screen.findByRole('button', { name: /^Slot 2: empty/ }))
    await waitFor(() => expect(backend.connection.editing).toBe(true))
    const staged = await backend.getVault()
    expect(staged.status === 'ok' && staged.data.content.banks[0].boxes[0].slots[1]).toBe(acquired)
    await clickReady(screen.getByRole('button', { name: 'Roll back staged changes' }))
    await waitFor(() => expect(backend.connection.editing).toBe(false))
    expect(fixture.records).toHaveLength(2)
    expect(fixture.vault.content.banks[0].boxes[0].slots[1]).toBeNull()
    expect(fixture.records[1].metadata).toEqual({ pokemon_id: acquired, favorite: false, tags: [] })
  })

  it('re-uploads the exact complete save for inspection pages and COPY-imports only checked slots', async () => {
    await start()
    await loadSave()
    await clickReady(screen.getByRole('checkbox', { name: 'Copy Box 1, slot 1' }))
    await clickReady(screen.getByRole('button', { name: 'Next save page' }))
    await clickReady(await screen.findByRole('checkbox', { name: 'Copy Box 2, slot 1' }))
    await clickReady(screen.getByRole('button', { name: 'COPY selected Pokémon into vault' }))
    await waitFor(() => expect(fixture.copyCount).toBe(2))
    await waitFor(() => expect(backend.connection.revision).toBe(1))
    const inspections = requests('/saves/inspect').map((request) =>
      parseWire('SaveInspectRequest', request.body)
    )
    expect(inspections).toHaveLength(2)
    expect(inspections[1].input).toEqual(inspections[0].input)
    expect(inspections[1].cursor).toBe(fixture.pageCursor)
    expect(inspections[0].input.sha256).toBe(sha256(fixture.save))
    const imported = parseWire('PokemonImportRequest', requests('/pokemon/import')[0].body)
    expect(imported.kind).toBe('save')
    if (imported.kind !== 'save') throw new Error('Expected selected-save import')
    expect(imported.input).toEqual(inspections[0].input)
    expect(imported.selections).toEqual([
      {
        source: { kind: 'box', box: 0, slot: 0 },
        expected_pokemon_sha256: fixture.gen5.original.sha256,
        destination: null,
      },
      {
        source: { kind: 'box', box: 1, slot: 0 },
        expected_pokemon_sha256: fixture.gen5.original.sha256,
        destination: null,
      },
    ])
    expect(requests('/pokemon/import')[0].text).not.toContain('private-source.sav')
    expect(fixture.records).toHaveLength(3)
  })

  it('keeps strict export failures visible and requires explicit lossy consent before download', async () => {
    const download = vi.spyOn(backend.files, 'saveLocalFile').mockResolvedValue(null)
    render(<HouseholdWorkspace backend={backend} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await screen.findByText(fixture.pokemon.identifier)
    await clickReady(screen.getByRole('button', { name: 'Preview converted PKM' }))
    await screen.findByText(/Fixture requires explicit loss consent/)
    expect(fixture.conversionAttempts.at(-1)).toEqual({
      representation: 'converted',
      target_format: 'pk8',
      policy: { allow_lossy: false },
    })
    expect(download).not.toHaveBeenCalled()
    await clickReady(screen.getByLabelText(/I explicitly allow lossy conversion for this Pokémon/))
    await clickReady(screen.getByRole('button', { name: 'Preview converted PKM' }))
    await screen.findByText(/OHPKM-only metadata is not representable/)
    expect(fixture.conversionAttempts.at(-1)).toEqual({
      representation: 'converted',
      target_format: 'pk8',
      policy: { allow_lossy: true },
    })
    await clickReady(screen.getByRole('button', { name: 'Download validated artifact' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(download.mock.calls[0][0]).toEqual(fixture.pokemon.original)
    expect(requests('/pokemon/import')).toHaveLength(0)
    expect(requests('/actions')).toHaveLength(0)
  })

  it('exports the selected exact original artifact and canonical OHPKM with verified bytes', async () => {
    const download = vi.spyOn(backend.files, 'saveLocalFile').mockResolvedValue(null)
    render(<HouseholdWorkspace backend={backend} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await screen.findByText(fixture.pokemon.identifier)
    await clickReady(screen.getByRole('button', { name: 'Preview exact original' }))
    await screen.findByRole('heading', { name: 'Exact original' })
    expect(fixture.conversionAttempts.at(-1)).toEqual({
      representation: 'original',
      artifact_id: ORIGINAL,
    })
    await clickReady(screen.getByRole('button', { name: 'Download validated artifact' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(sha256(download.mock.calls[0][0])).toBe(fixture.original.sha256)
    await clickReady(screen.getByRole('button', { name: 'Preview canonical OHPKM' }))
    await screen.findByRole('heading', { name: 'Canonical OHPKM' })
    await clickReady(screen.getByRole('button', { name: 'Download validated artifact' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2))
    expect(download.mock.calls[1][0]).toEqual(fixture.pokemon.binary)
    expect(requests('/pokemon/import')).toHaveLength(0)
    expect(requests('/actions')).toHaveLength(0)
  })

  it('prepares and downloads a validated withdrawal copy without acknowledging local application', async () => {
    const download = vi.spyOn(backend.files, 'saveLocalFile').mockResolvedValue(null)
    render(<HouseholdWorkspace backend={backend} />)
    await screen.findByRole('grid')
    await clickReady(screen.getByRole('button', { name: /^Slot 1:/ }))
    await screen.findByText(fixture.pokemon.identifier)
    await clickReady(screen.getByRole('button', { name: 'Import / save workbench' }))
    await loadSave()
    await clickReady(screen.getByRole('radio', { name: 'Withdraw into Box 1, slot 3' }))
    await clickReady(
      screen.getByLabelText(/I explicitly permit lossy conversion for this withdrawal/)
    )
    await clickReady(screen.getByRole('button', { name: 'Preview withdrawal conversion' }))
    await screen.findByText(/OHPKM-only metadata is not representable/)
    await clickReady(
      screen.getByRole('button', { name: 'Prepare validated save copy (reserve only)' })
    )
    await screen.findByText('PREPARED', { selector: 'strong' })
    await waitFor(() => expect(backend.connection.revision).toBe(1))
    const prepareRequest = requests('/transfers')[0]
    const body = parseWire('PrepareTransferRequest', prepareRequest.body)
    expect(body.source).toBe('sd_export')
    expect(body.original_save.sha256).toBe(sha256(fixture.save))
    expect(body.plan).toEqual({
      direction: 'withdraw',
      entries: [
        {
          pokemon_id: POKEMON,
          destination: { kind: 'box', box: 0, slot: 2 },
          policy: { allow_lossy: true },
        },
      ],
    })
    expect(prepareRequest.headers['if-match']).toBe('"vault-0"')
    await clickReady(screen.getByRole('button', { name: 'Download validated prepared save copy' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(sha256(download.mock.calls[0][0])).toBe(fixture.preparedSave?.sha256)
    expect(requests('/actions')).toHaveLength(0)
    expect(fixture.records.some((item) => item.id === POKEMON)).toBe(true)
  })

  it('recovers a transfer by UUID and cancels only after re-reading matching original and backup', async () => {
    const transferId = id(999)
    await backend.api
      .prepare('prepareTransfer', {
        ifMatch: '"vault-0"',
        body: {
          transfer_id: transferId,
          source: 'sd_export',
          original_save: saveInput(fixture.save, 'gen5'),
          plan: {
            direction: 'withdraw',
            entries: [
              {
                pokemon_id: POKEMON,
                destination: { kind: 'box', box: 0, slot: 2 },
                policy: { allow_lossy: true },
              },
            ],
          },
        },
      })
      .send()
    await start()
    fireEvent.change(screen.getByLabelText('Transfer recovery UUID'), {
      target: { value: transferId },
    })
    await clickReady(screen.getByRole('button', { name: 'Refresh transfer state' }))
    await screen.findByText('PREPARED', { selector: 'strong' })
    await clickReady(
      screen.getByText('Cancel after verifying the original and a byte-exact backup')
    )
    expect(
      screen.getByRole('button', { name: 'Cancel reservation with verified original' })
    ).toBeDisabled()
    await waitFor(() =>
      expect(
        screen.getByLabelText('Current local save for cancellation verification')
      ).toBeEnabled()
    )
    fireEvent.change(screen.getByLabelText('Current local save for cancellation verification'), {
      target: { files: [new File([fixture.save], 'current.sav')] },
    })
    await screen.findByText('current.sav')
    await waitFor(() =>
      expect(screen.getByLabelText('Original backup for cancellation verification')).toBeEnabled()
    )
    fireEvent.change(screen.getByLabelText('Original backup for cancellation verification'), {
      target: { files: [new File([fixture.save], 'independent-backup.sav')] },
    })
    await screen.findByText('independent-backup.sav')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Cancel reservation with verified original' })
      ).toBeEnabled()
    )
    await clickReady(
      screen.getByRole('button', { name: 'Cancel reservation with verified original' })
    )
    await screen.findByText('CANCELLED', { selector: 'strong' })
    const actions = requests('/actions')
    expect(actions).toHaveLength(1)
    expect(parseWire('TransferAction', actions[0].body)).toEqual({
      action: 'cancel',
      observed_local_sha256: sha256(fixture.save),
      verified_backup_sha256: sha256(fixture.save),
    })
    expect(fixture.records.some((item) => item.id === POKEMON)).toBe(true)
  })

  it('rejects empty/oversize uploads before sending any import bytes', async () => {
    await start()
    fireEvent.change(screen.getByLabelText('PKM or OHPKM file'), {
      target: { files: [new File([], 'empty.pkm')] },
    })
    await screen.findByText(/Choose a nonempty file/)
    const oversized = new File([fixture.pokemon.original], 'too-large.pkm')
    Object.defineProperty(oversized, 'size', { value: 1_048_577 })
    fireEvent.change(screen.getByLabelText('PKM or OHPKM file'), { target: { files: [oversized] } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'COPY file into vault' })).toBeDisabled()
    )
    expect(requests('/pokemon/import')).toHaveLength(0)
  })
})
