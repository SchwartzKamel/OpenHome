import { afterEach, expect, it, vi } from 'vitest'
import { R } from '@openhome-core/util/functional'
import { loadLocalBackend } from '../local'

vi.mock('@tauri-apps/api/event', { spy: true })

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.restoreAllMocks()
})

it('conditionally reuses the original Tauri singleton, save paths, state commands and listener cleanup (bridge unit tier)', async () => {
  // This is an adapter regression test, explicitly not evidence of an actual native shell launch.
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  const [{ TauriBackend }, { Commands }, events] = await Promise.all([
    import('@openhome-core/tauri/backend'),
    import('@openhome-core/tauri/commands'),
    import('@tauri-apps/api/event'),
  ])
  const selected = await loadLocalBackend()
  expect(selected).toBe(TauriBackend)
  expect(selected.startTransaction).toBe(Commands.startTransaction)
  expect(selected.commitTransaction).toBe(Commands.commitTransaction)
  expect(selected.rollbackTransaction).toBe(Commands.rollbackTransaction)
  const read = vi.spyOn(Commands, 'get_file_bytes').mockResolvedValue(R.Ok([1, 0, 255]))
  const created = vi.spyOn(Commands, 'getFileCreated').mockResolvedValue(R.Ok(123))
  const path = {
    raw: '/client/saves/fixture.sav',
    name: 'fixture.sav',
    dir: '/client/saves',
    ext: 'sav',
    separator: '/',
  }
  const loaded = await selected.loadSaveFile(path)
  expect(loaded).toMatchObject({
    status: 'ok',
    data: { path, fileBytes: new Uint8Array([1, 0, 255]) },
  })
  expect(read).toHaveBeenCalledWith(path.raw)
  expect(created).toHaveBeenCalledWith(path.raw)
  const unlisten = vi.fn()
  const listen = vi.mocked(events.listen).mockResolvedValue(unlisten)
  const callback = vi.fn()
  const stop = selected.onMenuEvent('save', callback)
  expect(listen).toHaveBeenCalledWith('save', callback)
  stop()
  await Promise.resolve()
  expect(unlisten).toHaveBeenCalledTimes(1)
})
