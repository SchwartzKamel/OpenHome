import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act, createElement, StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RemoteBackend } from '@openhome-core/remote'
import type BackendInterface from '@openhome-core/backend/backendInterface'
import { parseWire } from '@openhome-core/remote/validation'
import App from '@openhome-ui/App'
import { PROFILE_STORAGE_KEY } from '../profiles'
import { QuietSocket, UiTransport } from './transport'

vi.mock('@openhome-core/tauri/backend', () => {
  throw new Error('Browser root evaluated Tauri backend')
})
vi.mock('@tauri-apps/api/core', () => {
  throw new Error('Browser root evaluated native APIs')
})
vi.mock('@tauri-apps/plugin-os', () => {
  throw new Error('Browser root evaluated native OS')
})
vi.mock('../LocalWorkspace', () => {
  throw new Error('Browser root evaluated the desktop workspace')
})

const backends: RemoteBackend[] = []
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), {
      media,
      matches: false,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })
  )
  vi.stubGlobal('WebSocket', QuietSocket)
})
afterEach(() => {
  cleanup()
  for (const backend of backends.splice(0)) backend.dispose()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function signIn() {
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'owner' } })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'correct-password-unit' },
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await vi.dynamicImportSettled()
  })
  await screen.findByRole('heading', { name: 'Household vault' })
}

function show(transport: UiTransport) {
  const backend = transport.backend()
  backends.push(backend)
  const dispose = vi.spyOn(backend, 'dispose')
  render(
    createElement(StrictMode, null, createElement<{ backend?: BackendInterface }>(App, { backend }))
  )
  return { backend, dispose }
}

it('wires the actual browser App chooser, stores only nonsecret profile fields, then mounts the actual household workspace after login', async () => {
  const transport = new UiTransport()
  vi.stubGlobal('fetch', transport.fetch)
  render(createElement(StrictMode, null, createElement(App)))
  fireEvent.click(screen.getByRole('button', { name: 'Connect later' }))
  expect(screen.getByRole('status')).toHaveTextContent(
    'You can connect to a household server later'
  )
  expect(transport.requests).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Local desktop' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Server profile name'), {
    target: { value: 'Family vault' },
  })
  fireEvent.change(screen.getByLabelText('Server origin'), {
    target: { value: 'https://household.test/' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Connect to server' }))
  await signIn()
  expect(screen.getByRole('main', { name: 'Household collection' })).toBeVisible()
  expect(screen.getByText('Signed in as', { exact: false })).toHaveTextContent('owner')
  const stored = JSON.parse(window.localStorage.getItem(PROFILE_STORAGE_KEY) ?? 'null')
  expect(stored).toEqual([{ name: 'Family vault', origin: 'https://household.test' }])
  expect(window.localStorage.length).toBe(1)
  expect(screen.queryByText(/correct-password-unit/)).toBeNull()
})

it('does not dispose a supplied backend during StrictMode cleanup; logout clears private UI even when server revocation fails', async () => {
  const transport = new UiTransport()
  const { backend, dispose } = show(transport)
  await signIn()
  expect(dispose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Account & 3DS pairing'))
  fireEvent.change(screen.getByLabelText('New member password'), {
    target: { value: 'private-unsent-new-password' },
  })
  transport.failLogout = true
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and confirm this action.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sign out and clear' }))
  await screen.findByLabelText('Password')
  await waitFor(() => expect(backend.api.authenticated).toBe(false))
  expect(screen.queryByRole('heading', { name: 'Household vault' })).toBeNull()
  expect(screen.queryByLabelText('New member password')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent(/Server revocation is unconfirmed/)
  expect(backend.connection.revision).toBeUndefined()
  expect(backend.connection.editing).toBe(false)
  expect(transport.requests.some((request) => request.url.pathname === '/api/v1/auth/logout')).toBe(
    true
  )
})

it.each([
  { outcome: 'acknowledged', failLogout: false },
  { outcome: 'unconfirmed', failLogout: true },
])(
  'confirmed privacy logout clears an in-flight commit session with $outcome revocation',
  async ({ failLogout }) => {
    const transport = new UiTransport()
    const { backend } = show(transport)
    await signIn()
    await waitFor(() => expect(backend.connection.coherent).toBe(true))
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    let commit: ReturnType<RemoteBackend['commitTransaction']> | undefined
    let released = false
    transport.failLogout = failLogout
    transport.intercept = async (request) => {
      if (request.url.pathname !== '/api/v1/vault/commit') return undefined
      const body = parseWire('VaultCommitRequest', request.body)
      if (body.mode !== 'delta') throw new Error('Expected the actual staged delta')
      const settings = body.commands.find((command) => command.op === 'settings_put')
      if (!settings || settings.op !== 'settings_put') throw new Error('Missing staged settings')
      transport.vault.content.settings = settings.settings
      transport.vault.revision++
      started.resolve()
      await response.promise
      return transport.json(
        {
          revision: transport.vault.revision,
          applied_commands: body.commands.length,
        },
        transport.vault.revision
      )
    }
    try {
      await act(async () => {
        const staged = await backend.stageCommands([
          {
            op: 'settings_put',
            settings: { ...transport.vault.content.settings, theme: 'dark' },
          },
        ])
        expect(staged.status).toBe('ok')
        commit = backend.commitTransaction()
        await started.promise
      })
      expect(backend.connection.editing).toBe(true)
      expect(backend.connection.uncertain).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
      const warning = screen.getByRole('alertdialog').textContent
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'I understand and confirm this action.' })
      )
      fireEvent.click(screen.getByRole('button', { name: 'Sign out and clear' }))
      await waitFor(() => expect(backend.api.authenticated).toBe(false))
      expect(released).toBe(false)
      expect(
        transport.requests.filter((request) => request.url.pathname === '/api/v1/auth/logout')
      ).toHaveLength(1)
      expect(screen.queryByRole('main', { name: 'Household collection' })).toBeNull()
      expect(screen.queryByText('Account & 3DS pairing')).toBeNull()
      expect(screen.queryByText(/Signed in as/)).toBeNull()
      expect(screen.getByLabelText('Password')).toHaveValue('')
      expect(backend.connection.editing).toBe(false)
      expect(backend.connection.revision).toBeUndefined()
      expect(warning).toMatch(/accepted or uncertain operation may still commit/i)
      if (failLogout) {
        expect(screen.getByRole('status')).toHaveTextContent('Server revocation is unconfirmed')
        expect(transport.bearer).toBeDefined()
      } else {
        expect(screen.getByRole('status')).toHaveTextContent('server confirmed session revocation')
        expect(transport.bearer).toBeUndefined()
      }
    } finally {
      released = true
      response.resolve()
      await act(async () => {
        await commit
      })
    }
    expect(backend.api.authenticated).toBe(false)
    expect(backend.connection.editing).toBe(false)
    expect(backend.connection.coherent).toBe(false)
    expect(backend.connection.revision).toBeUndefined()
    expect(screen.queryByRole('main', { name: 'Household collection' })).toBeNull()
    expect(transport.vault.revision).toBe(1)
    expect(transport.vault.content.settings.theme).toBe('dark')
  }
)

it('removes all private panels and prior identity on a definitive 401, then shows sign-in instead of an empty private vault', async () => {
  const transport = new UiTransport()
  const { backend } = show(transport)
  await signIn()
  transport.unauthorized = true
  await act(async () => {
    try {
      await backend.api.call('listDevices', {})
    } catch {
      /* Expected definitive 401. */
    }
  })
  await screen.findByLabelText('Password')
  expect(screen.queryByRole('main', { name: 'Household collection' })).toBeNull()
  expect(screen.queryByText('Account & 3DS pairing')).toBeNull()
  expect(screen.queryByText(/Signed in as/)).toBeNull()
  expect(screen.getByRole('alert')).toHaveTextContent('Private data was cleared')
  expect(backend.connection.coherent).toBe(false)
})

it('blocks profile switches while an actual backend commit is uncertain instead of disposing its receipt', async () => {
  const transport = new UiTransport()
  const { backend, dispose } = show(transport)
  await signIn()
  await waitFor(() => expect(backend.connection.coherent).toBe(true))
  await act(async () => {
    const staged = await backend.stageCommands([
      {
        op: 'settings_put',
        settings: { ...transport.vault.content.settings, theme: 'dark' },
      },
    ])
    expect(staged.status).toBe('ok')
    transport.intercept = (request) => {
      if (request.url.pathname === '/api/v1/vault/commit')
        throw new TypeError('Unit lost commit response')
      return undefined
    }
    const committed = await backend.commitTransaction()
    expect(committed.status).toBe('error')
  })
  expect(backend.connection.uncertain).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Switch connection' }))
  fireEvent.change(screen.getByLabelText('Server profile name'), {
    target: { value: 'Other server' },
  })
  fireEvent.change(screen.getByLabelText('Server origin'), {
    target: { value: 'https://other.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Connect to server' }))
  await screen.findByText(/Connection not switched/)
  expect(backend.connection.uncertain).toBe(true)
  expect(backend.connection.editing).toBe(true)
  expect(backend.api.authenticated).toBe(true)
  expect(dispose).not.toHaveBeenCalled()
  expect(
    transport.requests.every((request) => request.url.origin === 'https://household.test')
  ).toBe(true)
})

it('keeps a failed real-root login visible without remounting away its generic 401 feedback', async () => {
  const transport = new UiTransport()
  transport.intercept = (request) =>
    request.url.pathname === '/api/v1/auth/login'
      ? transport.error(401, 'unauthorized', 'Authentication failed')
      : undefined
  const { backend } = show(transport)
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'owner' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password-unit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Authentication failed')
  expect(screen.queryByRole('main', { name: 'Household collection' })).toBeNull()
  expect(screen.getByLabelText('Password')).toHaveValue('')
  expect(backend.api.authenticated).toBe(false)
})

it('allows only an explicit warned clear to abandon an uncertain sign-in, and labels revocation unconfirmed', async () => {
  const transport = new UiTransport()
  transport.loseLoginResponse = true
  const { backend } = show(transport)
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'owner' } })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'correct-password-unit' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByRole('button', { name: 'Retry same request' })
  fireEvent.click(screen.getByRole('button', { name: 'Clear pending sign-in' }))
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Prefer Retry same request first')
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and confirm this action.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sign out and clear' }))
  await screen.findByText(/Server revocation is unconfirmed/)
  expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent('Server revocation is unconfirmed')
  expect(backend.api.authenticated).toBe(false)
  expect(screen.getByLabelText('Password')).toHaveValue('')
})

it('retained restore blocks newly staged collection-form edits until explicit rollback, then replays unchanged', async () => {
  const transport = new UiTransport()
  let rejectRestore = true
  transport.intercept = (request) =>
    rejectRestore && request.url.pathname.endsWith('/restore')
      ? transport.error(503, 'storage_unavailable', 'Temporary restore failure')
      : undefined
  const { backend } = show(transport)
  await signIn()
  await waitFor(() => expect(backend.connection.coherent).toBe(true))
  fireEvent.click(screen.getByText('Snapshots & lossless JSON backups'))
  fireEvent.click(screen.getByRole('button', { name: 'Load snapshots' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Restore Before changes' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and confirm this action.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Restore snapshot now' }))
  await screen.findByRole('button', { name: 'Retry same request' })
  const first = transport.requests.find((request) => request.url.pathname.endsWith('/restore'))
  if (!first) throw new Error('The confirmed restore was not prepared and sent')
  fireEvent.click(screen.getByText('Manage banks and boxes'))
  fireEvent.change(screen.getByLabelText('Bank name'), {
    target: { value: 'New staged name' },
  })
  const stage = screen.getByRole('button', { name: 'Stage bank rename' })
  await waitFor(() => expect(stage).toBeEnabled())
  fireEvent.click(stage)
  await waitFor(() => expect(backend.connection.editing).toBe(true))
  expect(screen.getByRole('button', { name: 'Create snapshot' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Restore Before changes' })).toBeDisabled()
  rejectRestore = false
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }))
  })
  await waitFor(() => expect(screen.queryByText('Waiting for the server…')).toBeNull())
  expect(
    transport.requests.filter((request) => request.url.pathname.endsWith('/restore'))
  ).toHaveLength(1)
  expect(transport.vault.revision).toBe(0)
  expect(backend.connection.editing).toBe(true)
  expect(backend.connection.conflicted).toBe(false)
  expect(screen.getByText(/Resolve or explicitly roll back collection edits/)).toBeVisible()
  const staged = await backend.getVault()
  expect(staged.status).toBe('ok')
  if (staged.status === 'ok') expect(staged.data.content.banks[0].name).toBe('New staged name')
  const rollback = screen.getByRole('button', { name: 'Roll back staged changes' })
  await waitFor(() => expect(rollback).toBeEnabled())
  fireEvent.click(rollback)
  await waitFor(() => expect(backend.connection.editing).toBe(false))
  const retry = screen.getByRole('button', { name: 'Retry same request' })
  await waitFor(() => expect(retry).toBeEnabled())
  fireEvent.click(retry)
  await screen.findByText('Server confirmed revision 1 · 1 ID mappings')
  const restores = transport.requests.filter((request) => request.url.pathname.endsWith('/restore'))
  expect(restores).toHaveLength(2)
  expect(restores[1].text).toBe(first.text)
  expect(restores[1].headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'))
  expect(restores[1].headers.get('If-Match')).toBe(first.headers.get('If-Match'))
})
