import { File as NodeFile } from 'node:buffer'
import { afterEach, expect, it, vi } from 'vitest'
import { ClientFiles } from '../files'
import { loadLocalBackend } from '../local'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('cannot repopulate cleared private file memory when an upload finishes after logout', async () => {
  const files = new ClientFiles()
  let finish: (() => void) | undefined
  const uploading = files.upload({
    name: 'selected.sav',
    size: 1,
    lastModified: 0,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = () => resolve(new Uint8Array([9]).buffer)
      }),
  })
  files.clear()
  finish?.()
  await expect(uploading).rejects.toMatchObject({ code: 'cancelled' })
  expect(await files.getRecentSaves()).toEqual({})
})

it('keeps browser uploads in this tab, rejects arbitrary paths, and downloads exact bytes without fetch', async () => {
  const fetcher = vi.fn(() => {
    throw new Error('A local file was sent to a server')
  })
  vi.stubGlobal('fetch', fetcher)
  const files = new ClientFiles()
  const bytes = new Uint8Array([0, 0xff, 0x80, 2, 0])
  const path = await files.upload(
    new NodeFile([bytes], 'my-save.sav', { lastModified: 1_700_000_000_000 })
  )
  expect(path.raw).toMatch(/^client-file:/)
  expect(path.name).toBe('my-save.sav')
  expect((await files.loadSaveFile(path)).fileBytes).toEqual(bytes)
  await expect(files.loadSaveFile({ ...path, raw: '/server/private.sav' })).rejects.toMatchObject({
    code: 'unavailable',
  })
  let downloaded: Blob | undefined
  const revoke = vi.fn()
  const NativeURL = URL
  class DownloadURL extends NativeURL {
    static createObjectURL(blob: Blob | MediaSource) {
      if (!(blob instanceof Blob)) throw new Error('Expected binary Blob')
      downloaded = blob
      return 'blob:client-only'
    }
    static revokeObjectURL = revoke
  }
  vi.stubGlobal('URL', DownloadURL)
  let downloadName: string | undefined
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    downloadName = this.download
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await files.writeSaveFile(path.raw, bytes)
  expect(downloadName).toBe('my-save.sav')
  if (!downloaded) throw new Error('No browser download')
  const blob = downloaded
  const output = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error('Expected bytes'))
    reader.onerror = reject
    reader.readAsArrayBuffer(blob)
  })
  expect(new Uint8Array(output)).toEqual(bytes)
  vi.advanceTimersByTime(1000)
  expect(revoke).toHaveBeenCalledWith('blob:client-only')
  expect(fetcher).not.toHaveBeenCalled()
  files.clear()
  await expect(files.loadSaveFile(path)).rejects.toMatchObject({ code: 'unavailable' })
  await expect(files.pickFolder()).rejects.toMatchObject({ code: 'unavailable' })
  await expect(loadLocalBackend()).rejects.toMatchObject({ code: 'unavailable' })
})
