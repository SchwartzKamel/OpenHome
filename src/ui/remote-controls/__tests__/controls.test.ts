import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Theme } from '@radix-ui/themes'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RemoteBackend } from '@openhome-core/remote'
import AccountControls from '../AccountControls'
import BackupControls from '../BackupControls'
import { id } from '@openhome-core/remote/__test__/support'
import { UiTransport } from './transport'

const backends: RemoteBackend[] = []
afterEach(() => {
  cleanup()
  for (const backend of backends.splice(0)) backend.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function loggedIn(transport: UiTransport) {
  const backend = transport.backend()
  backends.push(backend)
  await backend.api.beginLogin('owner', 'correct-password-unit').send()
  return backend
}

it('generates the server six-digit one-use code with expiry and provides a manual-copy fallback without clipboard APIs', async () => {
  const transport = new UiTransport()
  const backend = await loggedIn(transport)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  render(
    createElement(Theme, null, createElement(AccountControls, { backend, user: transport.user }))
  )
  fireEvent.click(screen.getByText('Account & 3DS pairing'))
  fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }))
  const input = await screen.findByLabelText('One-use pairing code')
  expect(input).toHaveValue('001234')
  expect(screen.getByText(/Expires in \d+s/)).toHaveTextContent('10 attempts remaining')
  fireEvent.click(screen.getByRole('button', { name: 'Copy pairing code' }))
  expect(screen.getByRole('status')).toHaveTextContent('copy it manually')
  expect(input).toHaveFocus()
  const request = transport.requests.find(
    (request) => request.url.pathname === '/api/v1/pairing/codes'
  )
  expect(request?.text).toBe('{}')
  expect(request?.headers.get('Authorization')).toMatch(/^Bearer ohs_/)
  expect(screen.queryByLabelText(/raw token/i)).toBeNull()
})

it('shows Retry-After for pairing throttles, and a member cannot see account creation', async () => {
  const transport = new UiTransport()
  transport.user = { ...transport.user, role: 'member' }
  transport.intercept = (request) =>
    request.url.pathname === '/api/v1/pairing/codes'
      ? new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Try later' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        })
      : undefined
  const backend = await loggedIn(transport)
  render(
    createElement(Theme, null, createElement(AccountControls, { backend, user: transport.user }))
  )
  fireEvent.click(screen.getByText('Account & 3DS pairing'))
  expect(screen.queryByLabelText('New member password')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('Retry-After: 60 seconds')
  expect(screen.getByRole('button', { name: /Retry same request/ })).toBeDisabled()
})

it('requires explicit device revocation confirmation and uses a bodyless authenticated DELETE', async () => {
  const transport = new UiTransport()
  const backend = await loggedIn(transport)
  render(
    createElement(Theme, null, createElement(AccountControls, { backend, user: transport.user }))
  )
  fireEvent.click(screen.getByText('Account & 3DS pairing'))
  fireEvent.click(screen.getByRole('button', { name: 'Load devices' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke Living room 3DS' }))
  const confirm = screen.getByRole('button', { name: 'Revoke device now' })
  expect(confirm).toBeDisabled()
  expect(transport.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0)
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and confirm this action.' }))
  fireEvent.click(confirm)
  await screen.findByText('The server confirmed immediate device revocation.')
  const request = transport.requests.find((request) => request.method === 'DELETE')
  expect(request?.url.pathname).toBe(`/api/v1/devices/${id(20)}`)
  expect(request?.text).toBe('')
  expect(request?.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Revoke Living room 3DS' })).toBeDisabled()
  )
})

it('defaults an admin-created account to member without replacing the current login', async () => {
  const transport = new UiTransport()
  const backend = await loggedIn(transport)
  render(
    createElement(Theme, null, createElement(AccountControls, { backend, user: transport.user }))
  )
  fireEvent.click(screen.getByText('Account & 3DS pairing'))
  expect(screen.getByLabelText('Account role')).toHaveValue('member')
  fireEvent.change(screen.getByLabelText('New member username'), { target: { value: 'guest' } })
  fireEvent.change(screen.getByLabelText('New member password'), {
    target: { value: 'guest-password-unit' },
  })
  const generation = backend.api.generation
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
  await screen.findByText('Created guest as member.')
  const request = transport.requests.find(
    (request) => request.url.pathname === '/api/v1/auth/users'
  )
  expect(request?.body).toEqual({
    username: 'guest',
    password: 'guest-password-unit',
    role: 'member',
  })
  expect(screen.getByLabelText('New member password')).toHaveValue('')
  expect(backend.api.generation).toBe(generation)
})

it('retains every acknowledged device revocation when later list refreshes fail', async () => {
  const transport = new UiTransport()
  transport.devices.push({
    ...transport.devices[0],
    id: id(25),
    name: 'Bedroom 3DS',
  })
  let failList = false
  transport.intercept = (request) =>
    failList && request.url.pathname === '/api/v1/devices'
      ? transport.error(503, 'storage_unavailable', 'Device list is unavailable')
      : undefined
  const backend = await loggedIn(transport)
  render(
    createElement(Theme, null, createElement(AccountControls, { backend, user: transport.user }))
  )
  fireEvent.click(screen.getByText('Account & 3DS pairing'))
  fireEvent.click(screen.getByRole('button', { name: 'Load devices' }))
  const first = await screen.findByRole('button', { name: 'Revoke Living room 3DS' })
  const second = screen.getByRole('button', { name: 'Revoke Bedroom 3DS' })
  failList = true
  for (const [index, button] of [first, second].entries()) {
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and confirm this action.' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke device now' }))
    await waitFor(() => expect(button).toBeDisabled())
    await waitFor(() =>
      expect(transport.requests.filter((request) => request.method === 'DELETE')).toHaveLength(
        index + 1
      )
    )
  }
  await waitFor(() => expect(screen.queryByText('Waiting for the server…')).toBeNull())
  expect(await screen.findByRole('alert')).toHaveTextContent('storage_unavailable')
  expect(first).toBeDisabled()
  expect(second).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent(
    'server confirmed immediate device revocation'
  )
})

it('reads a real strong vault ETag only after destructive snapshot consent and displays the returned mapping', async () => {
  const transport = new UiTransport()
  const backend = await loggedIn(transport)
  render(createElement(Theme, null, createElement(BackupControls, { backend })))
  fireEvent.click(screen.getByText('Snapshots & lossless JSON backups'))
  fireEvent.click(screen.getByRole('button', { name: 'Load snapshots' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Restore Before changes' }))
  const button = screen.getByRole('button', { name: 'Restore snapshot now' })
  expect(button).toBeDisabled()
  expect(transport.requests.some((request) => request.url.pathname.endsWith('/restore'))).toBe(
    false
  )
  fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and confirm this action.' }))
  fireEvent.click(button)
  await screen.findByText('Server confirmed revision 1 · 1 ID mappings')
  const request = transport.requests.find((request) => request.url.pathname.endsWith('/restore'))
  expect(request?.headers.get('If-Match')).toBe('"vault-0"')
  expect(request?.text).toBe('{}')
  expect(request?.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/)
  expect(screen.getByText('Server confirmed revision 1 · 1 ID mappings')).toBeVisible()
})
