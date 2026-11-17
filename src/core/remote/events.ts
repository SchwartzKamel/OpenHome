import { RemoteClient } from './client'
import { RemoteError, remoteError } from './errors'
import { parseJson, parseWire } from './validation'
import type { EventServerFrame } from './wire-types'

export interface EventSocket {
  readyState: number
  onopen: ((event: Event) => unknown) | null
  onmessage: ((event: MessageEvent) => unknown) | null
  onclose: ((event: CloseEvent) => unknown) | null
  onerror: ((event: Event) => unknown) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type SocketFactory = (url: string, protocol: string) => EventSocket

export interface EventCallbacks {
  resync(): Promise<number>
  invalidated(): void
  synchronized?(): void
  event?(frame: EventServerFrame): void
  error(error: RemoteError): void
}

export class RemoteEvents {
  private socket?: EventSocket
  private stopped = true
  private lastProcessed?: number
  private watermark?: number
  private minimumRevision = 0
  private pending: EventServerFrame[] = []
  private synchronizing?: Promise<void>
  private heartbeat?: ReturnType<typeof setInterval>
  private authenticationTimer?: ReturnType<typeof setTimeout>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempt = 0
  private missedPongs = 0
  private nonce = 0
  private waitingForPong?: number
  private retryDelay = 0

  constructor(
    private readonly client: RemoteClient,
    private readonly callbacks: EventCallbacks,
    private readonly factory: SocketFactory = (url, protocol) => new WebSocket(url, protocol)
  ) {}

  get processedSequence(): number | undefined {
    return this.lastProcessed
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.pending = []
    this.synchronizing = undefined
    this.watermark = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.onopen = null
      socket.onerror = null
      socket.close(1000)
    }
  }

  private clearTimers() {
    clearInterval(this.heartbeat)
    clearTimeout(this.authenticationTimer)
    clearTimeout(this.reconnectTimer)
  }

  private connect() {
    if (this.stopped || !this.client.authenticated) return
    try {
      const url = new URL('/api/v1/events', this.client.baseUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      // Only a fixed protocol name is sent at upgrade. The bearer is a first-frame secret.
      const authentication = this.client.eventAuthentication(this.lastProcessed)
      const socket = this.factory(url.href, 'openhome.events.v1')
      this.socket = socket
      this.watermark = undefined
      socket.onopen = () => {
        if (this.socket !== socket || this.stopped) return
        socket.send(JSON.stringify(authentication))
        this.authenticationTimer = setTimeout(() => {
          this.protocolError(new RemoteError('protocol_error', 'Event authentication timed out'))
        }, 5000)
      }
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.stopped) return
        try {
          if (
            typeof event.data !== 'string' ||
            new TextEncoder().encode(event.data).length > 4096
          ) {
            throw new RemoteError('protocol_error', 'Invalid or oversized event frame')
          }
          this.receive(parseWire('EventServerFrame', parseJson(event.data)))
        } catch (error) {
          this.protocolError(remoteError(error))
        }
      }
      socket.onerror = () => {
        this.callbacks.error(new RemoteError('network_error', 'The event connection failed'))
      }
      socket.onclose = (event) => {
        if (this.socket !== socket || this.stopped) return
        this.clearTimers()
        this.socket = undefined
        this.watermark = undefined
        this.pending = []
        this.synchronizing = undefined
        this.callbacks.invalidated()
        if (event.code === 4401) {
          this.stopped = true
          this.client.clearCredentials()
          this.callbacks.error(new RemoteError('unauthorized', 'Authentication failed', 401))
          return
        }
        if (event.code === 4403) {
          this.stopped = true
          this.callbacks.error(
            new RemoteError('forbidden', 'The server rejected the event scope or Origin', 403)
          )
          return
        }
        // A disconnection loses invalidations even when its reconnect later replays events.
        if (!this.retryDelay) {
          void this.callbacks
            .resync()
            .then(() => {
              if (!this.stopped && !this.socket) this.callbacks.synchronized?.()
            })
            .catch((error: unknown) => {
              if (!this.stopped) this.callbacks.error(remoteError(error))
            })
        }
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          Math.max(this.retryDelay, Math.min(30_000, 1000 * 2 ** this.reconnectAttempt++))
        )
      }
    } catch (error) {
      this.stopped = true
      this.callbacks.error(remoteError(error))
    }
  }

  private receive(frame: EventServerFrame) {
    if (frame.type === 'authenticated') {
      if (this.watermark !== undefined)
        throw new RemoteError('protocol_error', 'Repeated event authentication')
      clearTimeout(this.authenticationTimer)
      this.watermark = frame.sequence
      this.minimumRevision = frame.revision
      this.reconnectAttempt = 0
      this.missedPongs = 0
      this.waitingForPong = undefined
      this.heartbeat = setInterval(() => {
        if (this.waitingForPong !== undefined && ++this.missedPongs >= 2) {
          this.socket?.close(4000, 'Heartbeat timeout')
          return
        }
        this.nonce = (this.nonce + 1) % 2_147_483_648
        this.waitingForPong = this.nonce
        this.socket?.send(JSON.stringify({ type: 'ping', nonce: this.nonce }))
      }, 30_000)
      this.callbacks.invalidated()
      this.synchronize()
      return
    }
    if (this.watermark === undefined)
      throw new RemoteError('protocol_error', 'Private event before authentication')
    if (frame.type === 'pong') {
      if (frame.nonce !== this.waitingForPong)
        throw new RemoteError('protocol_error', 'Unexpected heartbeat nonce')
      this.waitingForPong = undefined
      this.missedPongs = 0
      return
    }
    if (frame.type === 'resync_required') {
      this.watermark = frame.sequence
      this.minimumRevision = frame.revision
      this.pending = this.pending.filter(
        (event) => 'sequence' in event && event.sequence > frame.sequence
      )
    } else {
      if (frame.sequence <= this.watermark) return
      if ('revision' in frame) this.minimumRevision = Math.max(this.minimumRevision, frame.revision)
      if (this.pending.length >= 256) {
        this.watermark = frame.sequence
        this.pending = []
      } else {
        this.pending.push(frame)
      }
    }
    this.callbacks.event?.(frame)
    this.callbacks.invalidated()
    this.synchronize()
  }

  private synchronize() {
    if (this.synchronizing) return
    const socket = this.socket
    const synchronizing = (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const watermark = this.watermark
        const target = this.pending.at(-1)
        const sequence = target && 'sequence' in target ? target.sequence : watermark
        const revision = await this.callbacks.resync()
        if (this.stopped || this.socket !== socket) return
        if (watermark !== this.watermark) continue
        const pending = this.pending
        const newer =
          revision < this.minimumRevision ||
          pending.some((frame) => 'revision' in frame && frame.revision > revision)
        const changed = pending.at(-1) !== target
        if (newer || changed) continue
        this.lastProcessed = sequence
        this.pending = []
        this.retryDelay = 0
        this.callbacks.synchronized?.()
        return
      }
      throw new RemoteError(
        'stale_revision',
        'Events changed during resync; reconnect before showing coherent state'
      )
    })()
      .catch((error: unknown) => {
        if (this.stopped || this.socket !== socket) return
        const failure = remoteError(error)
        this.retryDelay = (failure.retryAfterSeconds ?? 0) * 1000
        this.callbacks.error(failure)
        if (this.socket === socket) this.socket?.close(4000, 'Resync required')
      })
      .finally(() => {
        if (this.synchronizing === synchronizing) this.synchronizing = undefined
      })
    this.synchronizing = synchronizing
  }

  private protocolError(error: RemoteError) {
    this.callbacks.invalidated()
    this.callbacks.error(error)
    this.socket?.close(4400, 'Invalid event protocol')
  }
}
