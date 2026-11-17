import type BackendInterface from '@openhome-core/backend/backendInterface'
import type { PathData } from '@openhome-core/save/util/path'
import type { SaveFolder } from '@openhome-core/save/util/storage'
import type { LoadSaveResponse, SaveRef } from '@openhome-core/util/types'
import { newId } from './crypto'
import { RemoteError, unavailable, unwrap } from './errors'
import { isDesktopShell, loadLocalBackend } from './local'

export class ClientFiles {
  private epoch = 0
  private native?: BackendInterface
  private readonly uploads = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; path: PathData; modified: Date }
  >()
  private readonly recent: Record<string, SaveRef> = {}

  clear(): void {
    this.epoch++
    this.uploads.clear()
    for (const key of Object.keys(this.recent)) delete this.recent[key]
  }

  async upload(
    file: Pick<File, 'name' | 'size' | 'lastModified' | 'arrayBuffer'>
  ): Promise<PathData> {
    const generation = this.epoch
    if (file.size < 1 || file.size > 16_777_216) {
      throw new RemoteError('limit_exceeded', 'Selected local files must contain 1 byte to 16 MiB')
    }
    const raw = `client-file:${newId()}`
    const name = file.name.replaceAll('\\', '/').split('/').at(-1) || 'save.bin'
    const path = {
      raw,
      name,
      dir: '',
      separator: '/',
      ext: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '',
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (generation !== this.epoch) {
      throw new RemoteError('cancelled', 'Local file selection was cleared while reading')
    }
    this.uploads.set(raw, { bytes, path, modified: new Date(file.lastModified) })
    return path
  }

  private async desktop(): Promise<BackendInterface> {
    this.native ??= await loadLocalBackend()
    return this.native
  }

  initialize = async (): Promise<void> => {
    if (isDesktopShell()) await this.desktop()
  }

  getPlatform = (): string => {
    if (!isDesktopShell()) return 'web'
    if (!this.native)
      unavailable('getPlatform', 'connect before requesting the desktop file bridge platform')
    return this.native.getPlatform()
  }

  pickFile = async (): Promise<PathData | undefined> => {
    if (isDesktopShell()) return unwrap(await (await this.desktop()).pickFile())
    if (typeof document === 'undefined')
      unavailable('pickFile', 'a browser file picker requires a document')
    return new Promise((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.hidden = true
      const cleanup = () => input.remove()
      input.addEventListener(
        'change',
        () => {
          const file = input.files?.[0]
          cleanup()
          if (!file) resolve(undefined)
          else this.upload(file).then(resolve, reject)
        },
        { once: true }
      )
      input.addEventListener(
        'cancel',
        () => {
          cleanup()
          resolve(undefined)
        },
        { once: true }
      )
      document.body.append(input)
      input.click()
    })
  }

  loadSaveFile = async (path: PathData): Promise<LoadSaveResponse> => {
    if (isDesktopShell()) return unwrap(await (await this.desktop()).loadSaveFile(path))
    const selected = this.uploads.get(path.raw)
    if (!selected) {
      throw new RemoteError(
        'unavailable',
        'Browser paths cannot be read; select or upload the local file first'
      )
    }
    return {
      path: { ...selected.path },
      fileBytes: new Uint8Array(selected.bytes),
      createdDate: new Date(selected.modified),
    }
  }

  saveLocalFile = async (bytes: Uint8Array, suggestedName: string): Promise<null> => {
    if (isDesktopShell())
      return unwrap(await (await this.desktop()).saveLocalFile(bytes, suggestedName))
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
      unavailable('saveLocalFile', 'a browser download requires a document and Blob URLs')
    }
    const name = suggestedName.replaceAll('\\', '/').split('/').at(-1) || 'openhome.bin'
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
    const link = document.createElement('a')
    try {
      link.href = url
      link.download = name
      document.body.append(link)
      link.click()
    } finally {
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return null
  }

  writeSaveFile = async (path: string, bytes: Uint8Array): Promise<null> => {
    if (isDesktopShell()) return unwrap(await (await this.desktop()).writeSaveFile(path, bytes))
    const selected = this.uploads.get(path)
    if (!selected) unavailable('writeSaveFile', 'the file must be a selected browser upload')
    // A browser never overwrites a path; it explicitly downloads an owned copy.
    return this.saveLocalFile(bytes, selected.path.name)
  }

  getRecentSaves = async (): Promise<Record<string, SaveRef>> =>
    isDesktopShell()
      ? unwrap(await (await this.desktop()).getRecentSaves())
      : structuredClone(this.recent)

  addRecentSave = async (save: SaveRef): Promise<null> => {
    if (isDesktopShell()) return unwrap(await (await this.desktop()).addRecentSave(save))
    if (!this.uploads.has(save.filePath.raw))
      unavailable('addRecentSave', 'the file was not selected in this tab')
    this.recent[save.filePath.raw] = { ...save, lastOpened: Date.now() }
    return null
  }

  removeRecentSave = async (path: string): Promise<null> => {
    if (isDesktopShell()) return unwrap(await (await this.desktop()).removeRecentSave(path))
    delete this.recent[path]
    return null
  }

  pickFolder = async (): Promise<string | undefined> => {
    if (!isDesktopShell())
      unavailable('pickFolder', 'browsers upload files, not server directories')
    return unwrap(await (await this.desktop()).pickFolder())
  }

  getSaveFolders = async (): Promise<SaveFolder[]> => {
    if (!isDesktopShell())
      unavailable('getSaveFolders', 'automatic directory access is desktop-only')
    return unwrap(await (await this.desktop()).getSaveFolders())
  }

  upsertSaveFolder = async (path: string, label: string): Promise<null> => {
    if (!isDesktopShell())
      unavailable('upsertSaveFolder', 'automatic directory access is desktop-only')
    return unwrap(await (await this.desktop()).upsertSaveFolder(path, label))
  }

  removeSaveFolder = async (path: string): Promise<null> => {
    if (!isDesktopShell())
      unavailable('removeSaveFolder', 'automatic directory access is desktop-only')
    return unwrap(await (await this.desktop()).removeSaveFolder(path))
  }

  findSuggestedSaves = async () => {
    if (!isDesktopShell())
      unavailable('findSuggestedSaves', 'browsers cannot scan local directories')
    return unwrap(await (await this.desktop()).findSuggestedSaves())
  }

  openDirectory = async (path: string): Promise<null> => {
    if (!isDesktopShell()) unavailable('openDirectory', 'a desktop shell is required')
    return unwrap(await (await this.desktop()).openDirectory(path))
  }

  openFileLocation = async (path: string): Promise<null> => {
    if (!isDesktopShell()) unavailable('openFileLocation', 'a desktop shell is required')
    return unwrap(await (await this.desktop()).openFileLocation(path))
  }

  getResourcesPath = async (): Promise<string> => {
    if (!isDesktopShell())
      unavailable('getResourcesPath', 'browser resources use public asset URLs, not native paths')
    return (await this.desktop()).getResourcesPath()
  }

  convertLocalImagePath = (path: string): string => {
    if (!this.native || !isDesktopShell()) {
      unavailable(
        'convertLocalImagePath',
        'native local images require an initialized desktop file bridge'
      )
    }
    return this.native.convertLocalImagePath(path)
  }
}
