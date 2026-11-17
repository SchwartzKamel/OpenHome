import { act } from 'react'
import ReactDOM, { type Root } from 'react-dom/client'
import { screen, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

// These fail on module evaluation, not only on native invocation: a browser entry
// must not eagerly import the local backend or generated Tauri command runtime.
vi.mock('@openhome-core/tauri/backend', () => {
  throw new Error('Browser imported the Tauri backend')
})
vi.mock('@tauri-apps/api/core', () => {
  throw new Error('Browser imported Tauri core')
})
vi.mock('@tauri-apps/plugin-os', () => {
  throw new Error('Browser imported native OS APIs')
})

let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('imports and renders the real browser entry without Tauri globals or private API requests, and can connect later', async () => {
  // The existing test setup initializes the actual generated WASM, not a WASM stub.
  expect('__TAURI_INTERNALS__' in window).toBe(false)
  const fetcher = vi.fn(() => {
    throw new Error('Disconnected startup made a network request')
  })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), {
      media,
      matches: false,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })
  )
  const nativeCreateRoot = ReactDOM.createRoot
  vi.spyOn(ReactDOM, 'createRoot').mockImplementation((container, options) => {
    root = nativeCreateRoot(container, options)
    return root
  })
  document.body.innerHTML = '<div id="root"></div>'
  await act(async () => {
    await import('../../../main')
  })
  expect(screen.getByRole('heading', { name: 'OpenHome' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Connect later' }))
  expect(screen.getByRole('status')).toHaveTextContent(
    'You can connect to a household server later'
  )
  expect(fetcher).not.toHaveBeenCalled()
  expect('__TAURI_INTERNALS__' in window).toBe(false)
})
