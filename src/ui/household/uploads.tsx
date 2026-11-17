import { saveInput, RemoteError, type PokemonFormat, type SaveFamily } from '@openhome-core/remote'
import { useState, type DragEvent } from 'react'
import { useHousehold } from './workspace'

export const pokemonFormats: readonly PokemonFormat[] = [
  'ohpkm',
  'pk1',
  'pk2',
  'pk3',
  'pk4',
  'pk5',
  'pk6',
  'pk7',
  'pb7',
  'pk8',
  'pb8',
  'pa8',
  'pk9',
  'pa9',
]
export const saveFamilies: readonly SaveFamily[] = [
  'gen1',
  'gen2',
  'gen3',
  'gen4',
  'gen5',
  'gen6',
  'gen7',
  'lets_go',
  'sword_shield',
  'bdsp',
  'legends_arceus',
  'scarlet_violet',
  'legends_za',
]
export interface Upload {
  name: string
  bytes: Uint8Array<ArrayBuffer>
  sha256: string
}

export async function readUpload(file: File, maximum: number): Promise<Upload> {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximum)
    throw new RemoteError(
      'limit_exceeded',
      `Choose a nonempty file no larger than ${maximum.toLocaleString()} bytes.`
    )
  let buffer: ArrayBuffer
  if (typeof file.arrayBuffer === 'function') buffer = await file.arrayBuffer()
  else
    buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        reader.result instanceof ArrayBuffer
          ? resolve(reader.result)
          : reject(
              new RemoteError('invalid_bytes', 'Local file did not contain readable binary bytes')
            )
      reader.onerror = () => reject(new RemoteError('invalid_bytes', 'Local file read failed'))
      reader.readAsArrayBuffer(file)
    })
  const bytes = new Uint8Array(buffer)
  if (bytes.length !== file.size || bytes.length > maximum)
    throw new RemoteError('invalid_bytes', 'Local file size changed while reading')
  const sha256 = saveInput(bytes).sha256
  return { name: file.name.replaceAll('\\', '/').split('/').at(-1) || 'upload.bin', bytes, sha256 }
}

export function FileUpload({
  label,
  maximum,
  accept,
  upload,
  onUpload,
  disabled = false,
}: {
  label: string
  maximum: number
  accept?: string
  upload?: Upload
  onUpload: (upload: Upload) => void
  disabled?: boolean
}) {
  const { local, isCurrent, locked, report } = useHousehold()
  const [dragging, setDragging] = useState(false)
  const choose = (file?: File) => {
    if (!file || disabled || locked) return
    void local(async () => {
      const selected = await readUpload(file, maximum)
      if (isCurrent()) onUpload(selected)
    })
  }
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (disabled || locked) return
    if (event.dataTransfer.files.length !== 1) {
      report(new RemoteError('invalid_request', 'Drop exactly one binary file at a time.'))
      return
    }
    choose(event.dataTransfer.files[0])
  }
  return (
    <div
      className={`hh-upload${dragging ? ' hh-dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled && !locked) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <label>
        {label}
        <input
          type="file"
          accept={accept}
          disabled={disabled || locked}
          onChange={(event) => {
            choose(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </label>
      <small>
        Or drop one file here. Limit {maximum.toLocaleString()} bytes. Its name/path stays on this
        client.
      </small>
      {upload && (
        <div>
          <strong>{upload.name}</strong> · {upload.bytes.length.toLocaleString()} bytes
          <code className="hh-digest">{upload.sha256}</code>
        </div>
      )}
    </div>
  )
}
