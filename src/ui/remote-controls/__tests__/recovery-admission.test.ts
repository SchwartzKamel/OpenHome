import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Theme } from '@radix-ui/themes'
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  Bundle,
  IdMapping,
  PreparedRequest,
  RemoteBackend,
  SnapshotCreated,
} from '@openhome-core/remote'
import { parseWire } from '@openhome-core/remote/validation'
import { id } from '@openhome-core/remote/__test__/support'
import BackupControls from '../BackupControls'
import FolderControls from '../FolderControls'
import { jsonBytes } from '../bundles'
import { vaultMutationAdmission } from '../common'
import { usePreparedAction } from '../safety'
import { UiTransport } from './transport'

const backends: RemoteBackend[] = []
afterEach(() => {
  cleanup()
  for (const backend of backends.splice(0)) backend.dispose()
  vi.restoreAllMocks()
})

function selectedFile(path: string, value: unknown): File {
  const bytes = jsonBytes(value)
  const file = new File([bytes], path.split('/').at(-1) ?? path, { type: 'application/json' })
  Object.defineProperties(file, {
    arrayBuffer: { value: async () => new Uint8Array(bytes).buffer },
    webkitRelativePath: { value: path },
  })
  return file
}

function acceptEmptyImport(transport: UiTransport, bundle: Bundle): Response {
  const mappings: IdMapping[] = []
  const banks = bundle.content.banks.map((bank, bankIndex) => {
    const bankId = id(100 + bankIndex)
    mappings.push({ kind: 'bank', source_id: bank.id, destination_id: bankId })
    return {
      ...bank,
      id: bankId,
      boxes: bank.boxes.map((box, boxIndex) => {
        const boxId = id(200 + bankIndex * 64 + boxIndex)
        mappings.push({ kind: 'box', source_id: box.id, destination_id: boxId })
        return { ...box, id: boxId }
      }),
    }
  })
  const compatibility = bundle.content.openhome_compatibility
  transport.vault.content = {
    ...bundle.content,
    banks,
    ...(compatibility && {
      openhome_compatibility: {
        ...compatibility,
        banks: compatibility.banks.map((bank, bankIndex) => ({
          ...bank,
          bank_id: banks[bankIndex].id,
          boxes: bank.boxes.map((box, boxIndex) => ({
            ...box,
            box_id: banks[bankIndex].boxes[boxIndex].id,
          })),
        })),
      },
    }),
  }
  transport.vault.revision++
  return transport.json(
    {
      revision: transport.vault.revision,
      id_map: mappings,
    },
    transport.vault.revision
  )
}

it('rechecks admission after request preparation before its first dispatch, then sends that same request after rollback', async () => {
  const transport = new UiTransport()
  const originalBank = structuredClone(transport.vault.content.banks[0])
  const backend = transport.backend()
  backends.push(backend)
  await backend.api.beginLogin('owner', 'correct-password-unit').send()
  expect((await backend.connect()).status).toBe('ok')
  const read = await backend.api.call('getVault', { query: { view: 'full' } })
  const tag = parseWire('VaultETag', read.etag)
  const acknowledged = vi.fn()
  const { result } = renderHook(() =>
    usePreparedAction<SnapshotCreated>(backend, acknowledged, false, () =>
      vaultMutationAdmission(backend)
    )
  )
  let prepared: PreparedRequest<SnapshotCreated> | undefined
  const prepare = vi.fn(async () => {
    const request = backend.api.prepare('createSnapshot', {
      body: { label: 'Prepared before local edits' },
      ifMatch: tag,
    })
    prepared = request
    expect(
      (
        await backend.stageCommands([
          {
            op: 'bank_put',
            bank: { ...originalBank, name: 'Edit after preparation' },
          },
        ])
      ).status
    ).toBe('ok')
    return request
  })
  await act(async () => {
    await result.current.start(prepare)
  })
  const attempts = () =>
    transport.requests.filter(
      (request) => request.method === 'POST' && request.url.pathname === '/api/v1/snapshots'
    )
  expect(attempts()).toHaveLength(0)
  expect(result.current.retained).toBe(true)
  expect(result.current.admissionProblem).toMatch(
    /Resolve or explicitly roll back collection edits/
  )
  expect(backend.connection.editing).toBe(true)
  expect(acknowledged).not.toHaveBeenCalled()
  const retained = prepared
  if (!retained) throw new Error('No prepared request was retained')
  await act(async () => {
    expect((await backend.rollbackTransaction()).status).toBe('ok')
    await result.current.retry()
  })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(attempts()).toHaveLength(1)
  expect(attempts()[0].headers.get('Idempotency-Key')).toBe(retained.idempotencyKey)
  expect(attempts()[0].headers.get('If-Match')).toBe(tag)
  expect(acknowledged).toHaveBeenCalledTimes(1)
  expect(result.current.retained).toBe(false)
})

it.each(['snapshot', 'JSON bundle', 'OpenHome folder'] as const)(
  'retained %s retry honors new edit admission without changing its prepared request',
  async (kind) => {
    const transport = new UiTransport()
    const originalBank = structuredClone(transport.vault.content.banks[0])
    const directoryDescriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'webkitdirectory'
    )

    if (kind === 'OpenHome folder')
      Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', {
        configurable: true,
        value: false,
      })
    const path = kind === 'snapshot' ? '/api/v1/snapshots' : '/api/v1/bundles/import'
    let recover = false
    let receipt: Response | undefined
    transport.intercept = (request) => {
      if (request.method !== 'POST' || request.url.pathname !== path) return undefined
      if (!recover) {
        if (kind === 'OpenHome folder') {
          const input = parseWire('BundleImportRequest', request.body)
          receipt = acceptEmptyImport(transport, input.bundle)
          throw new TypeError('An accepted import response was lost')
        }
        return transport.error(503, 'storage_unavailable', 'Temporary recovery failure')
      }
      if (receipt) return receipt.clone()
      if (kind !== 'snapshot') {
        const input = parseWire('BundleImportRequest', request.body)
        return acceptEmptyImport(transport, input.bundle)
      }
      return undefined
    }
    const backend = transport.backend()
    backends.push(backend)
    await backend.api.beginLogin('owner', 'correct-password-unit').send()
    expect((await backend.connect()).status).toBe('ok')
    try {
      render(
        createElement(
          Theme,
          null,
          kind === 'OpenHome folder'
            ? createElement(FolderControls, { backend })
            : createElement(BackupControls, { backend })
        )
      )
      if (kind === 'OpenHome folder') {
        fireEvent.click(screen.getByText('Upstream OpenHome folder adapter'))
        fireEvent.change(screen.getByLabelText('OpenHome storage folder'), {
          target: {
            files: [
              selectedFile('storage/banks.json', {
                current_bank: 0,
                banks: [
                  {
                    id: originalBank.id,
                    name: null,
                    index: 0,
                    current_box: 0,
                    boxes: [
                      { id: originalBank.boxes[0].id, name: null, index: 0, identifiers: {} },
                    ],
                  },
                ],
              }),
              selectedFile('storage/pokedex.json', {}),
            ],
          },
        })
        fireEvent.change(screen.getByLabelText('Folder import mode'), {
          target: { value: 'replace' },
        })
        fireEvent.click(await screen.findByRole('button', { name: 'Review folder replace' }))
        fireEvent.click(
          screen.getByRole('checkbox', { name: 'I understand and confirm this action.' })
        )
        fireEvent.click(screen.getByRole('button', { name: 'Replace from folder' }))
      } else {
        fireEvent.click(screen.getByText('Snapshots & lossless JSON backups'))
        if (kind === 'snapshot') {
          fireEvent.change(screen.getByLabelText('Snapshot label'), {
            target: { value: 'Retained snapshot' },
          })
          fireEvent.click(screen.getByRole('button', { name: 'Create snapshot' }))
        } else {
          const bundle: Bundle = {
            format: 'openhome-vault-bundle',
            version: 1,
            source_revision: 0,
            content: structuredClone(transport.vault.content),
            pokemon: [],
            artifacts: [],
          }
          fireEvent.change(screen.getByLabelText('Preview server JSON bundle'), {
            target: { files: [selectedFile('bundle.json', bundle)] },
          })
          fireEvent.change(screen.getByLabelText('Bundle import mode'), {
            target: { value: 'replace' },
          })
          fireEvent.click(await screen.findByRole('button', { name: 'Review replace import' }))
          fireEvent.click(
            screen.getByRole('checkbox', { name: 'I understand and confirm this action.' })
          )
          fireEvent.click(screen.getByRole('button', { name: 'Replace from bundle' }))
        }
      }
      await screen.findByRole('button', { name: 'Retry same request' })
      const attempts = () =>
        transport.requests.filter(
          (request) => request.method === 'POST' && request.url.pathname === path
        )
      const first = attempts()[0]
      if (!first) throw new Error('No actual prepared recovery request was dispatched')
      await act(async () => {
        expect(
          (
            await backend.stageCommands([
              {
                op: 'bank_put',
                bank: { ...originalBank, name: 'Staged while recovery pending' },
              },
            ])
          ).status
        ).toBe('ok')
      })
      recover = true
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }))
      })
      await waitFor(() => expect(screen.queryByText('Waiting for the server…')).toBeNull())
      expect(attempts()).toHaveLength(1)
      expect(backend.connection.editing).toBe(true)
      expect(backend.connection.conflicted).toBe(false)
      expect(screen.getByText(/Resolve or explicitly roll back collection edits/)).toBeVisible()
      if (kind === 'OpenHome folder') {
        expect(screen.getByText(/Outcome uncertain/)).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Dismiss request / edit' })).toBeNull()
      }
      await act(async () => {
        expect((await backend.rollbackTransaction()).status).toBe('ok')
      })
      const retry = screen.getByRole('button', { name: 'Retry same request' })
      await waitFor(() => expect(retry).toBeEnabled())
      fireEvent.click(retry)
      await waitFor(() => expect(attempts()).toHaveLength(2))
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull()
      )
      const replay = attempts()[1]
      expect(replay.text).toBe(first.text)
      expect(replay.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'))
      expect(replay.headers.get('If-Match')).toBe(first.headers.get('If-Match'))
      expect(backend.connection.editing).toBe(false)
      expect(transport.vault.revision).toBe(1)
    } finally {
      if (kind === 'OpenHome folder') {
        if (directoryDescriptor)
          Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', directoryDescriptor)
        else Reflect.deleteProperty(HTMLInputElement.prototype, 'webkitdirectory')
      }
    }
  }
)
