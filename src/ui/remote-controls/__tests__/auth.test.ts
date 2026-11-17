import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { Theme } from '@radix-ui/themes'
import { act, createElement, StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteBackend } from '@openhome-core/remote'
import AuthForm from '../AuthForm'
import { PROFILE_STORAGE_KEY } from '../profiles'
import { UiTransport } from './transport'

const backends: RemoteBackend[] = []
afterEach(() => {
  cleanup()
  for (const backend of backends.splice(0)) backend.dispose()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

function showAuth(transport: UiTransport, baseUrl?: string) {
  const backend = transport.backend(baseUrl)
  backends.push(backend)
  const authenticated = vi.fn()
  render(
    createElement(
      StrictMode,
      null,
      createElement(
        Theme,
        null,
        createElement(AuthForm, { backend, onAuthenticated: authenticated })
      )
    )
  )
  return { backend, authenticated }
}

function credentials() {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'correct-password-unit' },
  })
}

it('requires explicit HTTP acknowledgement before even preparing a credential request', async () => {
  const transport = new UiTransport()
  const { backend, authenticated } = showAuth(transport, 'http://192.168.1.20:8080')
  const begin = vi.spyOn(backend.api, 'beginLogin')
  credentials()
  const signIn = screen.getByRole('button', { name: 'Sign in' })
  expect(signIn).toBeDisabled()
  const form = signIn.closest('form')
  if (!form) throw new Error('Missing actual authentication form')
  fireEvent.submit(form)
  expect(begin).not.toHaveBeenCalled()
  expect(transport.requests).toHaveLength(0)
  expect(screen.getByText(/Insecure HTTP LAN connection/)).toBeVisible()
  fireEvent.click(screen.getByRole('checkbox', { name: /explicitly allow sending credentials/ }))
  fireEvent.click(signIn)
  await waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1))
  const login = transport.requests[0]
  expect(login.url.origin).toBe('http://192.168.1.20:8080')
  expect(login.text).toMatch(/"token":"ohs_[A-Za-z0-9_-]{43}"/)
  expect(window.localStorage.getItem(PROFILE_STORAGE_KEY)).toBeNull()
  expect(window.localStorage.length).toBe(0)
})

it('retains the exact prepared login token, key and body after an uncertain response and retries it', async () => {
  const transport = new UiTransport()
  transport.loseLoginResponse = true
  const { backend, authenticated } = showAuth(transport)
  const begin = vi.spyOn(backend.api, 'beginLogin')
  credentials()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByRole('button', { name: 'Retry same request' })
  expect(screen.getByRole('alert')).toHaveTextContent(/Outcome uncertain/)
  expect(screen.getByLabelText('Password')).toHaveValue('')
  expect(screen.getByLabelText('Username')).toBeDisabled()
  const first = transport.requests[0]
  expect(first.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/)
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }))
  await waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1))
  expect(begin).toHaveBeenCalledTimes(1)
  expect(transport.requests[1].text).toBe(first.text)
  expect(transport.requests[1].headers.get('Idempotency-Key')).toBe(
    first.headers.get('Idempotency-Key')
  )
  expect(backend.api.authenticated).toBe(true)
  expect(window.localStorage.length).toBe(0)
})

it('keeps uncertainty sticky through a definitive failed receipt replay instead of allowing a fresh intent', async () => {
  const transport = new UiTransport()
  transport.loseLoginResponse = true
  const { authenticated } = showAuth(transport)
  credentials()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByRole('button', { name: 'Retry same request' })
  transport.intercept = (request) =>
    request.url.pathname === '/api/v1/auth/login'
      ? transport.error(503, 'storage_unavailable', 'Receipt unavailable')
      : undefined
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('storage_unavailable'))
  expect(screen.getByRole('alert')).toHaveTextContent('Outcome uncertain')
  expect(screen.queryByRole('button', { name: 'Dismiss request / edit' })).toBeNull()
  expect(screen.getByLabelText('Username')).toBeDisabled()
  transport.intercept = undefined
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }))
  await waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1))
  expect(transport.requests).toHaveLength(3)
  const first = transport.requests[0]
  for (const replay of transport.requests.slice(1)) {
    expect(replay.text).toBe(first.text)
    expect(replay.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'))
  }
})

it('bootstraps only with the explicit operator secret and a pre-generated candidate, with no public signup', async () => {
  const transport = new UiTransport()
  const { authenticated } = showAuth(transport)
  fireEvent.click(screen.getByRole('button', { name: 'First run? Set up the owner' }))
  expect(screen.getByText('server/data/setup-token')).toBeVisible()
  credentials()
  fireEvent.change(screen.getByLabelText('One-time setup secret'), {
    target: { value: 'unit-operator-secret-never-persist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create first owner' }))
  await waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1))
  const request = transport.requests[0]
  expect(request.url.pathname).toBe('/api/v1/auth/bootstrap')
  expect(request.headers.get('X-Setup-Token')).toBe('unit-operator-secret-never-persist')
  expect(request.text).toMatch(/"token":"ohs_[A-Za-z0-9_-]{43}"/)
  expect(screen.getByLabelText('One-time setup secret')).toHaveValue('')
  expect(window.localStorage.length).toBe(0)
})

it('guards duplicate submit events before constructing another bearer candidate or superseding the pending proof', async () => {
  const transport = new UiTransport()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  transport.intercept = async (request) => {
    if (request.url.pathname === '/api/v1/auth/login') await gate
    return undefined
  }
  const { backend, authenticated } = showAuth(transport)
  const begin = vi.spyOn(backend.api, 'beginLogin')
  credentials()
  const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')
  if (!form) throw new Error('No actual login form')
  act(() => {
    fireEvent.submit(form)
    fireEvent.submit(form)
  })
  await waitFor(() => expect(transport.requests).toHaveLength(1))
  expect(begin).toHaveBeenCalledTimes(1)
  await act(async () => {
    release?.()
    await gate
  })
  await waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1))
  expect(backend.api.authenticated).toBe(true)
})

it('never assigns an old grant or admin role to a replacement credential generation after delayed UI delivery', async () => {
  const transport = new UiTransport()
  const { backend, authenticated } = showAuth(transport)
  const nativeBegin = backend.api.beginLogin.bind(backend.api)
  vi.spyOn(backend.api, 'beginLogin').mockImplementation((username, password) => {
    const request = nativeBegin(username, password)
    return {
      ...request,
      send: async () => {
        const oldGrant = await request.send()
        await nativeBegin('replacement', 'replacement-password-unit').send()
        return oldGrant
      },
    }
  })
  credentials()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByRole('alert')
  expect(authenticated).not.toHaveBeenCalled()
  expect(backend.api.authenticated).toBe(true)
  expect(transport.requests).toHaveLength(2)
  expect(transport.requests[1].text).toContain('"username":"replacement"')
})
