import type BackendInterface from '@openhome-core/backend/backendInterface'
import type {
  AppState,
  BackendCapabilities,
  BackendListeners,
  ItemBag,
  LogLevel,
  MenuEvent,
  OhpkmStore,
  StoredLookups,
} from '@openhome-core/backend/backendInterface'
import { getMonGen12Identifier, getMonGen345Identifier } from '@openhome-core/pkm/Lookup'
import type { OHPKM } from '@openhome-core/pkm/OHPKM'
import type { SAV, SaveWriter } from '@openhome-core/save/interfaces'
import type { StoredBankData } from '@openhome-core/save/util/storage'
import type {
  ConvertStrategyEntries,
  Filter,
  PaginationCursor,
} from '@openhome-core/tauri/spectaCommands'
import type { PaginatedPage } from '@openhome-core/tauri/spectaCommands'
import { R } from '@openhome-core/util/functional'
import type { NowOrLater } from '@openhome-core/util/promise'
import type { AppTheme, Settings } from '@openhome-ui/state/appInfo'
import type { ConvertStrategies } from '@openhome-ui/state/convert-strategies'
import type { LogFilter } from '@openhome-ui/pages/logs'
import type { OhpkmBatchLookupResults } from '@openhome-ui/state/ohpkm'
import { isOriginGameStr } from '@openhome-ui/util/pokedex'
import type { Pokedex, PokedexUpdate } from '@openhome-ui/util/pokedex'
import type { Dayjs } from 'dayjs'
import { type PreparedRequest, RemoteClient, type RemoteClientOptions } from './client'
import { decodeBytes } from './crypto'
import { failed, RemoteError, remoteError, type RemoteResult, unavailable } from './errors'
import { RemoteEvents, type SocketFactory } from './events'
import { ClientFiles } from './files'
import { IdentityMap, projectBanks, translateBanks } from './identity'
import {
  applyCommands,
  type CollectionSnapshot,
  compatibility,
  trackerCounts,
  validateContent,
} from './state'
import { parseWire } from './validation'
import type * as Wire from './wire-types'

interface PreparedCommit {
  readonly request: PreparedRequest<Wire.VaultCommitResult>
  readonly revision: number
  readonly appliedCommands: number
}

interface EditState {
  base: CollectionSnapshot
  content: Wire.VaultContent
  activeIds: Set<string>
  commands: Wire.VaultCommand[]
  replace: boolean
  explicit: boolean
  prepared?: PreparedCommit
  uncertain: boolean
  inFlight: boolean
}

interface Checkpoint {
  transaction: EditState
  content: Wire.VaultContent
  activeIds: Set<string>
  commands: Wire.VaultCommand[]
  replace: boolean
}

export interface RemoteConnectionState {
  authenticated: boolean
  coherent: boolean
  revision?: number
  editing: boolean
  conflicted: boolean
  uncertain: boolean
  transportSecurity: RemoteClient['transportSecurity']
  status?: Wire.Status
  lastError?: RemoteError
  lastCommittedRevision?: number
  eventSequence?: number
}

const unavailableOperations = {
  addToLookups:
    'legacy Gen1–5 lookup strings are not the API source-SHA256 lookup type; use typed lookup commands',
  removeDangling: 'server records and archived originals must be managed explicitly',
  addToOhpkmStore:
    'canonical bytes are immutable; use an explicit COPY import outside a transaction, not arbitrary tracked-data edits',
  getOhpkmIdsMatchingUnknownHandler: 'handler repair is an upstream local-only operation',
  promptChangeDataDir: 'the server never exposes its filesystem',
  promptMoveDataDir: 'the server never exposes its filesystem',
  getDataDirPath: 'remote vaults have no client-visible data-directory path',
  loadItemBag: 'the frozen vault contract has no item-bag store',
  saveItemBag: 'the frozen vault contract has no item-bag store',
  getConvertStrategies:
    'local conversion flags differ from typed target-format/loss-policy strategies; use the typed vault API',
  updateConvertStrategies:
    'local conversion flags cannot be silently mapped to a remote loss policy',
  getLogs: 'server logs are not exposed by the frozen API',
  log: 'remote logging is not a desktop IPC bridge',
  clearLogsForRange: 'server logs are not exposed by the frozen API',
  onNewLog: 'server logs are not exposed by the frozen API',
  listInstalledPlugins: 'remote plugin execution is forbidden',
  getPluginPath: 'remote plugin execution is forbidden',
  downloadPlugin: 'remote plugin execution is forbidden',
  loadPluginCode: 'remote plugin execution is forbidden',
  deletePlugin: 'remote plugin execution is forbidden',
} as const

export interface RemoteBackendOptions extends RemoteClientOptions {
  socketFactory?: SocketFactory
}

export class RemoteBackend implements BackendInterface {
  readonly api: RemoteClient
  readonly files = new ClientFiles()
  readonly capabilities: BackendCapabilities = {
    kind: 'remote',
    vaultSlotsPerBox: 30,
    plugins: false,
    arbitraryServerFiles: false,
    atomicLocalSaveAndVault: false,
    unavailable: unavailableOperations,
  }
  private authority?: CollectionSnapshot
  private edit?: EditState
  private readonly identities = new IdentityMap()
  private readonly binaryArtifacts = new Map<string, string>()
  private readonly checkpoints = new Map<number, Checkpoint>()
  private nextCheckpoint = 0
  private readonly subscribers = new Set<() => void>()
  private readonly listeners = new Set<Partial<BackendListeners>>()
  private readonly menuListeners = new Map<MenuEvent, Set<() => NowOrLater<unknown>>>()
  private coherent = false
  private eventSyncPending = false
  private conflicted = false
  private lastError?: RemoteError
  private status?: Wire.Status
  private lastCommittedRevision?: number
  private refreshing?: Promise<CollectionSnapshot>
  private hydrating?: Promise<void>
  private events?: RemoteEvents
  private eventLease = 0
  private publication = 0
  private invalidationVersion = 0
  private readonly unsubscribeCredential: () => void
  private readonly unsubscribeMutations: () => void
  private uiSettings?: Settings

  constructor(private readonly options: RemoteBackendOptions) {
    this.api = new RemoteClient(options)
    this.unsubscribeCredential = this.api.subscribeCredentials(() => {
      this.eventLease++
      this.events?.stop()
      this.events = undefined
      this.authority = undefined
      this.edit = undefined
      this.checkpoints.clear()
      this.identities.clear()
      this.binaryArtifacts.clear()
      this.files.clear()
      this.status = undefined
      this.uiSettings = undefined
      this.coherent = false
      this.eventSyncPending = false
      this.conflicted = false
      this.lastCommittedRevision = undefined
      this.lastError = undefined
      this.refreshing = undefined
      this.hydrating = undefined
      this.publishCollection()
      this.notify()
    })
    this.unsubscribeMutations = this.api.subscribeMutations(() => this.invalidate())
  }

  get connection(): RemoteConnectionState {
    return {
      authenticated: this.api.authenticated,
      coherent: this.coherent,
      revision: this.authority?.vault.revision,
      editing: this.edit !== undefined,
      conflicted: this.conflicted,
      uncertain: this.edit?.uncertain ?? false,
      transportSecurity: this.api.transportSecurity,
      status: this.status && structuredClone(this.status),
      lastError: this.lastError ?? this.api.observerError,
      lastCommittedRevision: this.lastCommittedRevision,
      eventSequence: this.events?.processedSequence,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  private notify() {
    for (const listener of this.subscribers) {
      try {
        listener()
      } catch {
        this.lastError = new RemoteError('internal_error', 'A client connection listener failed')
      }
    }
    for (const listener of this.listeners) {
      this.deliver(() => listener.onStateUpdate?.remote_connection?.(this.connection))
    }
  }

  private deliver(callback: () => void) {
    try {
      callback()
    } catch {
      this.lastError = new RemoteError('internal_error', 'A client collection listener failed')
    }
  }

  private publishCollection() {
    const generation = this.api.generation
    const publication = ++this.publication
    for (const listener of this.listeners) {
      const snapshot = this.edit?.base ?? this.authority
      if (!this.api.authenticated || !snapshot) {
        this.deliver(() => {
          listener.onLookupsUpdate?.({ gen12: {}, gen345: {} })
          listener.onPokedexUpdate?.({ byDexNumber: {} })
          listener.onStateUpdate?.vault?.(undefined)
        })
        continue
      }
      if (!this.coherent && !this.edit) continue
      const content = this.edit?.content ?? snapshot.vault.content
      const layout = content.openhome_compatibility
      const bank = layout?.current_bank ?? 0
      this.deliver(() => {
        listener.onStateUpdate?.vault?.(structuredClone(this.visibleVault(snapshot)))
        listener.onBankOrBoxChange?.({ bank, box: layout?.banks[bank]?.current_box ?? 0 })
      })
      const current = () =>
        this.api.generation === generation &&
        this.publication === publication &&
        this.listeners.has(listener)
      if (listener.onPokedexUpdate) {
        void this.loadPokedex().then((result) => {
          if (result.status === 'ok' && current()) {
            this.deliver(() => listener.onPokedexUpdate?.(result.data))
          }
        })
      }
      if (listener.onLookupsUpdate) {
        void this.loadLookups().then((result) => {
          if (result.status === 'ok' && current()) {
            this.deliver(() => listener.onLookupsUpdate?.(result.data))
          }
        })
      }
    }
  }

  private recordError(error: unknown): RemoteError {
    const failure = remoteError(error)
    // Cancelled old reads must not replace the error/state of a newer session.
    if (failure.code === 'cancelled') return failure
    this.lastError = failure
    this.notify()
    return failure
  }

  private async result<T>(
    operation: () => T | Promise<T>,
    acknowledgedWrite = false
  ): Promise<RemoteResult<T>> {
    const generation = this.api.generation
    try {
      const data = await operation()
      if (!acknowledgedWrite && generation !== this.api.generation) {
        throw new RemoteError('cancelled', 'Authentication changed during this client operation')
      }
      return { status: 'ok', data }
    } catch (error) {
      const failure = remoteError(error)
      return failed(
        generation !== this.api.generation && this.api.authenticated
          ? failure
          : this.recordError(failure)
      )
    }
  }

  private reject<T>(operation: keyof typeof unavailableOperations): Promise<RemoteResult<T>> {
    return this.result(() => unavailable(operation, unavailableOperations[operation]))
  }

  connect = (): Promise<RemoteResult<null>> => {
    const lease = this.eventLease
    return this.result(async () => {
      await this.files.initialize()
      await this.refresh()
      if (lease === this.eventLease) this.startEvents()
      return null
    })
  }

  dispose = (): void => {
    this.stopEvents()
    this.api.clearCredentials()
    this.unsubscribeCredential()
    this.unsubscribeMutations()
    this.authority = undefined
    this.edit = undefined
    this.identities.clear()
    this.binaryArtifacts.clear()
    this.files.clear()
    this.checkpoints.clear()
    this.subscribers.clear()
    this.listeners.clear()
    this.menuListeners.clear()
  }

  private startEvents() {
    this.events ??= new RemoteEvents(
      this.api,
      {
        resync: async () => (await this.refresh()).vault.revision,
        invalidated: () => {
          this.eventSyncPending = true
          this.invalidate()
        },
        synchronized: () => {
          this.eventSyncPending = false
          this.coherent =
            this.authority !== undefined &&
            this.authority.vault.revision >= (this.lastCommittedRevision ?? 0)
          this.notify()
          this.publishCollection()
        },
        error: (error) => {
          this.recordError(error)
        },
      },
      this.options.socketFactory
    )
    this.events.start()
  }

  stopEvents = (): void => {
    this.eventLease++
    this.events?.stop()
    this.eventSyncPending = false
  }

  private invalidate() {
    this.invalidationVersion++
    this.coherent = false
    if (this.edit) this.conflicted = true
    this.notify()
  }

  resync = (): Promise<RemoteResult<Wire.VaultState>> =>
    this.result(async () => structuredClone((await this.refresh()).vault))

  private refresh(): Promise<CollectionSnapshot> {
    if (this.refreshing) return this.refreshing
    const generation = this.api.generation
    const refreshing = this.fetchSnapshot(generation)
    this.refreshing = refreshing
    void refreshing
      .finally(() => {
        if (this.refreshing === refreshing) this.refreshing = undefined
      })
      .catch(() => undefined)
    return refreshing
  }

  private pruneIdentities(snapshot: CollectionSnapshot) {
    for (const [id, artifact] of this.binaryArtifacts) {
      if (snapshot.records.get(id)?.ohpkm_artifact_id !== artifact) {
        this.binaryArtifacts.delete(id)
        this.identities.remove(id)
      }
    }
  }

  private requireGeneration(generation: number) {
    if (generation !== this.api.generation) {
      throw new RemoteError('cancelled', 'Authentication changed during synchronization')
    }
  }

  private async fetchSnapshot(generation: number): Promise<CollectionSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.requireGeneration(generation)
        const invalidation = this.invalidationVersion
        const status = this.status ?? (await this.api.call('getStatus', {})).data
        this.requireGeneration(generation)
        this.status = status
        const response = await this.api.call('getVault', { query: { view: 'full' } })
        this.requireGeneration(generation)
        if (response.data.view !== 'full')
          throw new RemoteError('protocol_error', 'The server did not return a full vault')
        const vault = response.data
        const records = new Map<string, Wire.PokemonRecord>()
        const cursors = new Set<string>()
        let cursor: string | undefined
        do {
          const page = await this.api.call('listPokemon', {
            query: {
              limit: status.limits.page_size,
              at_revision: vault.revision,
              ...(cursor && { cursor }),
            },
          })
          this.requireGeneration(generation)
          if (page.data.revision !== vault.revision) {
            throw new RemoteError('stale_revision', 'Pokemon pages crossed vault revisions', 409)
          }
          for (const record of page.data.items) {
            if (records.has(record.id) || record.metadata.pokemon_id !== record.id) {
              throw new RemoteError(
                'protocol_error',
                'Duplicate Pokemon or mismatched metadata in traversal'
              )
            }
            records.set(record.id, record)
          }
          if (records.size > status.limits.pokemon_per_vault)
            throw new RemoteError('limit_exceeded', 'The vault traversal exceeds the record limit')
          cursor = page.data.next_cursor ?? undefined
          if (cursor && cursors.has(cursor))
            throw new RemoteError('protocol_error', 'The server repeated a page cursor')
          if (cursor) cursors.add(cursor)
        } while (cursor)
        if (records.size !== vault.pokemon_count)
          throw new RemoteError('protocol_error', 'Vault count does not match the pinned traversal')
        validateContent(vault.content, new Set(records.keys()))
        const counts = trackerCounts(records.values())
        if (
          (['species', 'forms', 'moves', 'abilities', 'ribbons'] as const).some(
            (kind) => counts[kind] !== vault.pokedex[kind]
          )
        ) {
          throw new RemoteError(
            'protocol_error',
            'Vault trackers do not match the pinned owned records'
          )
        }
        for (const entry of vault.content.metadata) {
          const record = records.get(entry.pokemon_id)
          if (
            !record ||
            record.metadata.favorite !== entry.favorite ||
            JSON.stringify(record.metadata.tags) !== JSON.stringify(entry.tags)
          ) {
            throw new RemoteError('protocol_error', 'Vault and record metadata are inconsistent')
          }
        }
        this.requireGeneration(generation)
        // Compare at completion, not at read admission: an ACK can overtake a
        // perfectly valid older SQLite snapshot while it is still in transit.
        const floor = Math.max(this.lastCommittedRevision ?? 0, this.authority?.vault.revision ?? 0)
        if (invalidation !== this.invalidationVersion || vault.revision < floor) {
          throw new RemoteError(
            'stale_revision',
            'The snapshot predates an acknowledged write or invalidation'
          )
        }
        const snapshot = { vault, records, generation }
        this.authority = snapshot
        this.coherent = !this.eventSyncPending
        this.conflicted = !!this.edit && this.edit.base.vault.revision !== vault.revision
        this.lastError = undefined
        if (!this.edit) {
          this.pruneIdentities(this.authority)
        }
        this.notify()
        this.publishCollection()
        this.requireGeneration(generation)
        return snapshot
      } catch (error) {
        if (generation !== this.api.generation) {
          if (error instanceof RemoteError && error.code === 'unauthorized') throw error
          this.requireGeneration(generation)
        }
        if (error instanceof RemoteError && error.code === 'stale_revision' && attempt < 2) continue
        this.coherent = false
        throw this.recordError(error)
      }
    }
    throw new RemoteError('stale_revision', 'The vault kept changing during resync')
  }

  private visibleVault(snapshot: CollectionSnapshot): Wire.VaultState {
    const edit = this.edit
    if (!edit) return snapshot.vault
    const records = [...edit.base.records.values()].filter((record) =>
      edit.activeIds.has(record.id)
    )
    return {
      ...edit.base.vault,
      content: edit.content,
      pokemon_count: edit.activeIds.size,
      pokedex: trackerCounts(records),
    }
  }

  getVault = (): Promise<RemoteResult<Wire.VaultState>> =>
    this.result(async () => structuredClone(this.visibleVault(await this.snapshot())))

  getRecords = (): Promise<RemoteResult<Wire.PokemonRecord[]>> =>
    this.result(async () => {
      const snapshot = await this.snapshot()
      const content = this.edit?.content ?? snapshot.vault.content
      return [...snapshot.records.values()]
        .filter((record) => !this.edit || this.edit.activeIds.has(record.id))
        .map((record) => ({
          ...structuredClone(record),
          metadata: structuredClone(
            content.metadata.find((entry) => entry.pokemon_id === record.id) ?? record.metadata
          ),
        }))
    })

  private async snapshot(): Promise<CollectionSnapshot> {
    if (!this.api.authenticated) throw new RemoteError('unauthorized', 'Authentication failed', 401)
    if (this.edit) return this.edit.base
    return this.authority && this.coherent ? this.authority : this.refresh()
  }

  private async ensureEdit(): Promise<EditState> {
    if (!this.edit) {
      const generation = this.api.generation
      const base = await this.snapshot()
      if (generation !== this.api.generation)
        throw new RemoteError('cancelled', 'Authentication changed before staging')
      this.edit ??= {
        base,
        content: structuredClone(base.vault.content),
        activeIds: new Set(base.records.keys()),
        commands: [],
        replace: false,
        explicit: false,
        uncertain: false,
        inFlight: false,
      }
    }
    if (this.edit.inFlight || this.edit.uncertain) {
      throw new RemoteError(
        'uncertain_commit',
        'Replay the frozen commit request before changing or discarding these edits'
      )
    }
    return this.edit
  }

  private requireEdit(edit: EditState) {
    if (this.edit !== edit)
      throw new RemoteError('cancelled', 'The edit buffer was discarded or the connection changed')
    if (edit.inFlight || edit.uncertain) {
      throw new RemoteError(
        'uncertain_commit',
        'Replay the frozen commit request before changing these edits'
      )
    }
  }

  private applyStaged(edit: EditState, commands: Wire.VaultCommand[]) {
    this.requireEdit(edit)
    parseWire('VaultCommitRequest', { mode: 'delta', commands })
    if (edit.replace && commands.some((command) => command.op === 'pokemon_delete')) {
      unavailable(
        'pokemon_delete',
        'the frozen API cannot combine record deletion and a full content replacement in one commit'
      )
    }
    const combined = [...edit.commands, ...structuredClone(commands)]
    if (!edit.replace) parseWire('VaultCommitRequest', { mode: 'delta', commands: combined })
    const activeIds = new Set(edit.activeIds)
    const content = applyCommands(edit.content, commands, activeIds)
    this.requireEdit(edit)
    edit.content = content
    edit.activeIds = activeIds
    edit.commands = combined
    edit.prepared = undefined
    this.notify()
    this.publishCollection()
  }

  private replaceStaged(edit: EditState, content: Wire.VaultContent) {
    this.requireEdit(edit)
    if (edit.activeIds.size !== edit.base.records.size) {
      unavailable(
        'replace',
        'a replacement cannot include archived-record deletions in the same frozen command'
      )
    }
    const candidate = structuredClone(content)
    if (!candidate.openhome_compatibility && edit.content.openhome_compatibility) {
      candidate.openhome_compatibility = structuredClone(edit.content.openhome_compatibility)
    }
    if (candidate.openhome_compatibility)
      candidate.openhome_compatibility = compatibility(candidate)
    validateContent(candidate, edit.activeIds)
    this.requireEdit(edit)
    edit.content = candidate
    edit.replace = true
    edit.prepared = undefined
    this.notify()
    this.publishCollection()
  }

  startTransaction = (): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const edit = await this.ensureEdit()
      this.requireEdit(edit)
      if (edit.explicit)
        throw new RemoteError(
          'invalid_state',
          'A transaction is already open; retry, rebase or roll it back explicitly'
        )
      edit.explicit = true
      this.notify()
      return null
    })

  stageCommands = (commands: Wire.VaultCommand[]): Promise<RemoteResult<null>> =>
    this.result(async () => {
      this.applyStaged(await this.ensureEdit(), commands)
      return null
    })

  stageContent = (content: Wire.VaultContent): Promise<RemoteResult<null>> =>
    this.result(async () => {
      this.replaceStaged(await this.ensureEdit(), content)
      return null
    })

  checkpoint = (): Promise<RemoteResult<number>> =>
    this.result(async () => {
      const edit = await this.ensureEdit()
      this.requireEdit(edit)
      const id = ++this.nextCheckpoint
      this.checkpoints.set(id, {
        transaction: edit,
        content: structuredClone(edit.content),
        activeIds: new Set(edit.activeIds),
        commands: structuredClone(edit.commands),
        replace: edit.replace,
      })
      return id
    })

  rewind = (id: number): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const edit = await this.ensureEdit()
      this.requireEdit(edit)
      const checkpoint = this.checkpoints.get(id)
      if (!checkpoint || checkpoint.transaction !== edit)
        throw new RemoteError('invalid_state', 'Checkpoint is not part of this transaction')
      edit.content = structuredClone(checkpoint.content)
      edit.activeIds = new Set(checkpoint.activeIds)
      edit.commands = structuredClone(checkpoint.commands)
      edit.replace = checkpoint.replace
      edit.prepared = undefined
      this.notify()
      this.publishCollection()
      return null
    })

  rebaseTransaction = (
    merge: (current: Wire.VaultContent, staged: Wire.VaultContent) => Wire.VaultContent
  ): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const edit = await this.ensureEdit()
      this.requireEdit(edit)
      if (edit.activeIds.size !== edit.base.records.size) {
        unavailable(
          'rebaseTransaction',
          'explicitly restage deleted Pokemon against the latest vault after rollback'
        )
      }
      const latest = await this.refresh()
      this.requireEdit(edit)
      const content = structuredClone(
        merge(structuredClone(latest.vault.content), structuredClone(edit.content))
      )
      validateContent(content, new Set(latest.records.keys()))
      this.requireEdit(edit)
      this.edit = {
        ...edit,
        base: latest,
        content,
        activeIds: new Set(latest.records.keys()),
        commands: [],
        replace: true,
        prepared: undefined,
      }
      this.checkpoints.clear()
      this.pruneIdentities(latest)
      this.conflicted = false
      this.lastError = undefined
      this.notify()
      this.publishCollection()
      return null
    })

  commitTransaction = (): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const edit = this.edit
      if (!edit) throw new RemoteError('invalid_state', 'No transaction is open')
      if (edit.inFlight) throw new RemoteError('invalid_state', 'This commit is already in flight')
      validateContent(edit.content, edit.activeIds)
      const body: Wire.VaultCommitRequest = edit.replace
        ? { mode: 'replace', state: edit.content }
        : { mode: 'delta', commands: edit.commands }
      if (!edit.prepared) {
        parseWire('VaultCommitRequest', body)
        edit.prepared = Object.freeze({
          request: this.api.prepare('commitVault', {
            body,
            ifMatch: `"vault-${edit.base.vault.revision}"`,
          }),
          revision: edit.base.vault.revision + 1,
          appliedCommands: body.mode === 'replace' ? 1 : body.commands.length,
        })
      }
      const prepared = edit.prepared
      edit.inFlight = true
      try {
        const response = await prepared.request.send()
        if (this.edit !== edit)
          throw new RemoteError('cancelled', 'Authentication changed during commit')
        if (
          response.data.revision !== prepared.revision ||
          response.data.applied_commands !== prepared.appliedCommands
        ) {
          throw new RemoteError(
            'protocol_error',
            'Commit receipt does not match the staged transaction',
            undefined,
            undefined,
            true
          )
        }
        this.lastCommittedRevision = response.data.revision
        this.edit = undefined
        this.checkpoints.clear()
        this.coherent = false
        this.conflicted = false
        // The write is acknowledged. A later refresh failure is displayed separately,
        // never reported as a rolled-back write or retried with a fresh mutation key.
        try {
          await this.refresh()
        } catch (error) {
          this.recordError(error)
        }
        this.notify()
        this.publishCollection()
        return null
      } catch (error) {
        const failure = remoteError(error)
        // A failed receipt lookup cannot prove an earlier timed-out commit failed.
        edit.uncertain ||= failure.uncertain
        if (this.edit === edit && failure.code === 'stale_revision') {
          this.conflicted = true
          this.coherent = false
        }
        throw edit.uncertain && !failure.uncertain
          ? new RemoteError(
              failure.code,
              failure.message,
              failure.httpStatus,
              failure.details,
              true,
              failure.retryAfterSeconds
            )
          : failure
      } finally {
        edit.inFlight = false
      }
    }, true)

  rollbackTransaction = (): Promise<RemoteResult<null>> =>
    this.result(() => {
      if (!this.edit) throw new RemoteError('invalid_state', 'No transaction is open')
      this.requireEdit(this.edit)
      this.edit = undefined
      this.checkpoints.clear()
      if (this.authority) this.pruneIdentities(this.authority)
      this.conflicted = false
      this.lastError = undefined
      this.notify()
      this.publishCollection()
      return null
    })

  saveSyncedState = (): Promise<RemoteResult<null>> =>
    this.result(() => {
      if (!this.edit) throw new RemoteError('invalid_state', 'There is no staged state to save')
      this.requireEdit(this.edit)
      validateContent(this.edit.content, this.edit.activeIds)
      return null
    })

  private async hydrate(snapshot: CollectionSnapshot): Promise<void> {
    const generation = snapshot.generation
    this.requireGeneration(generation)
    if (this.hydrating) {
      await this.hydrating
      this.requireGeneration(generation)
      if (
        [...snapshot.records.values()].every(
          (record) => this.binaryArtifacts.get(record.id) === record.ohpkm_artifact_id
        )
      )
        return
    }
    const hydration = (async () => {
      for (const record of snapshot.records.values()) {
        if (this.binaryArtifacts.get(record.id) === record.ohpkm_artifact_id) continue
        const response = await this.api.call('exportPokemon', {
          path: { pokemon_id: record.id },
          body: { representation: 'ohpkm' },
        })
        this.requireGeneration(generation)
        if (response.data.revision !== snapshot.vault.revision) {
          this.invalidate()
          throw new RemoteError(
            'stale_revision',
            'The vault changed while loading binary identities; resync before continuing',
            409
          )
        }
        if (response.data.output.format !== 'ohpkm' || response.data.losses.length) {
          throw new RemoteError(
            'protocol_error',
            'Canonical OHPKM export changed representation or reported losses'
          )
        }
        const bytes = decodeBytes(response.data.output)
        if (generation !== this.api.generation)
          throw new RemoteError('cancelled', 'Authentication changed during binary loading')
        this.identities.register(record.id, bytes)
        this.binaryArtifacts.set(record.id, record.ohpkm_artifact_id)
      }
    })()
    this.hydrating = hydration
    try {
      await hydration
    } finally {
      if (this.hydrating === hydration) this.hydrating = undefined
    }
  }

  loadHomeBanks = (): Promise<RemoteResult<StoredBankData>> =>
    this.result(async () => {
      const snapshot = await this.snapshot()
      await this.hydrate(snapshot)
      return projectBanks(this.edit?.content ?? snapshot.vault.content, this.identities)
    })

  writeHomeBanks = (stored: StoredBankData): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const edit = await this.ensureEdit()
      await this.hydrate(edit.base)
      this.requireEdit(edit)
      const current = edit.content
      const translated = translateBanks(stored, current, this.identities)
      this.replaceStaged(edit, { ...current, ...translated })
      return null
    })

  lookupOhpkmById = (id: string): Promise<RemoteResult<OHPKM | undefined>> =>
    this.result(async () => {
      parseWire('OpenHomeId', id)
      const snapshot = await this.snapshot()
      await this.hydrate(snapshot)
      let serverId: string
      try {
        serverId = this.identities.serverId(id)
      } catch (error) {
        if (error instanceof RemoteError && error.code === 'not_found') return undefined
        throw error
      }
      if (this.edit && !this.edit.activeIds.has(serverId)) return undefined
      return this.identities.mon(serverId)
    })

  lookupOhpkmBatch = (ids: string[]): Promise<RemoteResult<OhpkmBatchLookupResults>> =>
    this.result(async () => {
      const results: OhpkmBatchLookupResults = new Map()
      for (const id of ids) {
        const result = await this.lookupOhpkmById(id)
        if (result.status === 'error') throw result.failure
        results.set(id, result.data ? R.Ok(result.data) : R.Err({ identifier: id }))
      }
      return results
    })

  getOhpkmCount = (): Promise<RemoteResult<number>> =>
    this.result(
      async () => this.edit?.activeIds.size ?? (await this.snapshot()).vault.pokemon_count
    )

  searchOhpkmStore = (
    cursor: PaginationCursor,
    filters: Filter[]
  ): Promise<RemoteResult<PaginatedPage<OHPKM>>> =>
    this.result(async () => {
      if (
        !Number.isSafeInteger(cursor.pageIndex) ||
        cursor.pageIndex < 0 ||
        !Number.isInteger(cursor.pageSize) ||
        cursor.pageSize < 1 ||
        cursor.pageSize > 100
      ) {
        throw new RemoteError('invalid_request', 'Legacy page index/size is out of range')
      }
      for (const filter of filters) {
        if (
          !(
            'nationalDex' in filter ||
            'formIndex' in filter ||
            'nicknamePrefix' in filter ||
            'isShiny' in filter ||
            'level' in filter
          )
        ) {
          unavailable(
            'searchOhpkmStore',
            'this legacy filter has no exact frozen wire mapping; use typed Pokemon filters'
          )
        }
      }
      const snapshot = await this.snapshot()
      await this.hydrate(snapshot)
      const matched = [...snapshot.records.values()].filter(
        (record) =>
          (!this.edit || this.edit.activeIds.has(record.id)) &&
          filters.every((filter) => {
            if ('nationalDex' in filter) return record.observed.species === filter.nationalDex
            if ('formIndex' in filter) return record.observed.form === filter.formIndex
            if ('nicknamePrefix' in filter)
              return record.observed.nickname
                .toLowerCase()
                .startsWith(filter.nicknamePrefix.toLowerCase())
            if ('isShiny' in filter) return record.observed.shiny === filter.isShiny
            if ('level' in filter) return record.observed.level === filter.level
            return false
          })
      )
      const start = cursor.pageIndex * cursor.pageSize
      const results = matched.slice(start, start + cursor.pageSize).map((record) => {
        this.identities.identifier(record.id)
        return this.identities.mon(record.id)
      })
      return {
        results,
        currentCursor: { ...cursor },
        nextCursor: { ...cursor, pageIndex: cursor.pageIndex + 1 },
        nextPageExists: start + cursor.pageSize < matched.length,
        totalCount: matched.length,
      }
    })

  deleteHomeMons = (ids: string[]): Promise<RemoteResult<null>> =>
    this.result(async () => {
      if (!ids.length) return null
      const edit = await this.ensureEdit()
      await this.hydrate(edit.base)
      this.requireEdit(edit)
      const commands: Wire.VaultCommand[] = ids.map((id) => ({
        op: 'pokemon_delete',
        pokemon_id: this.identities.serverId(id),
      }))
      this.applyStaged(edit, commands)
      return null
    })

  loadLookups = (): Promise<RemoteResult<StoredLookups>> =>
    this.result(async () => {
      const snapshot = await this.snapshot()
      await this.hydrate(snapshot)
      const lookups: StoredLookups = { gen12: {}, gen345: {} }
      for (const record of snapshot.records.values()) {
        if (this.edit && !this.edit.activeIds.has(record.id)) continue
        const id = this.identities.identifier(record.id)
        const mon = this.identities.mon(record.id)
        try {
          for (const [lookup, key] of [
            [lookups.gen12, getMonGen12Identifier(mon)],
            [lookups.gen345, getMonGen345Identifier(mon)],
          ] as const) {
            if (!key) continue
            if (lookup[key] && lookup[key] !== id) {
              throw new RemoteError(
                'identity_collision',
                'Two server copies have the same legacy generation lookup'
              )
            }
            lookup[key] = id
          }
        } finally {
          mon.free()
        }
      }
      return lookups
    })

  addToLookups = (_entries: StoredLookups) => this.reject<null>('addToLookups')
  removeDangling = () => this.reject<null>('removeDangling')
  addToOhpkmStore = (_updates: OhpkmStore) => this.reject<null>('addToOhpkmStore')
  getOhpkmIdsMatchingUnknownHandler = (_save: SAV) =>
    this.reject<string[]>('getOhpkmIdsMatchingUnknownHandler')
  promptChangeDataDir = () => this.reject<null>('promptChangeDataDir')
  promptMoveDataDir = () => this.reject<null>('promptMoveDataDir')
  getDataDirPath = () => this.reject<string>('getDataDirPath')

  loadPokedex = (): Promise<RemoteResult<Pokedex>> =>
    this.result(async () => {
      const snapshot = await this.snapshot()
      const pokedex: Pokedex = { byDexNumber: {} }
      for (const entry of (this.edit?.content ?? snapshot.vault.content).openhome_compatibility
        ?.pokedex_history ?? []) {
        if (!entry.games.every(isOriginGameStr))
          throw new RemoteError(
            'protocol_error',
            'Historical game names are not pinned OpenHome variants'
          )
        const dex = pokedex.byDexNumber[entry.species] ?? { forms: {} }
        dex.forms[entry.form] = { ...entry, games: entry.games.filter(isOriginGameStr) }
        pokedex.byDexNumber[entry.species] = dex
      }
      for (const record of snapshot.records.values()) {
        if (this.edit && !this.edit.activeIds.has(record.id)) continue
        const { species, form, shiny } = record.observed
        const dex = pokedex.byDexNumber[species] ?? { forms: {} }
        const old = dex.forms[form]
        dex.forms[form] = {
          level: shiny || old?.level === 'ShinyCaught' ? 'ShinyCaught' : 'Caught',
          games: old?.games ?? [],
          extra: old?.extra ?? [],
          flags: old?.flags ?? [],
          shiny_leaves: old?.shiny_leaves ?? 0,
        }
        pokedex.byDexNumber[species] = dex
      }
      return pokedex
    })

  registerInPokedex = (updates: PokedexUpdate[]): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const edit = await this.ensureEdit()
      const content = structuredClone(edit.content)
      const layout = compatibility(content)
      const entries = new Map(
        layout.pokedex_history.map((entry) => [`${entry.species}:${entry.form}`, entry])
      )
      const ranks = { Seen: 0, Caught: 1, ShinyCaught: 2 }
      for (const update of updates) {
        const key = `${update.nationalDex}:${update.formIndex}`
        const old = entries.get(key)
        const { data } = update
        const entry = parseWire('OpenHomePokedexEntry', {
          species: update.nationalDex,
          form: update.formIndex,
          level: old && ranks[old.level] > ranks[data.level] ? old.level : data.level,
          games: [...new Set([...(old?.games ?? []), ...data.games])],
          extra: [...new Set([...(old?.extra ?? []), ...data.extra])],
          flags: [...new Set([...(old?.flags ?? []), ...data.flags])],
          shiny_leaves: (old?.shiny_leaves ?? 0) | data.shiny_leaves,
        })
        entries.set(key, entry)
      }
      layout.pokedex_history = [...entries.values()].sort(
        (a, b) => a.species - b.species || a.form - b.form
      )
      content.openhome_compatibility = layout
      this.replaceStaged(edit, content)
      return null
    })

  syncPokedex = (): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const generation = this.api.generation
      const loaded = await this.loadPokedex()
      if (loaded.status === 'error') throw loaded.failure
      const updates: PokedexUpdate[] = []
      for (const [species, dex] of Object.entries(loaded.data.byDexNumber)) {
        for (const [form, data] of Object.entries(dex?.forms ?? {})) {
          if (data) updates.push({ nationalDex: Number(species), formIndex: Number(form), data })
        }
      }
      if (this.api.generation !== generation)
        throw new RemoteError('cancelled', 'Authentication changed during Pokedex sync')
      const result = await this.registerInPokedex(updates)
      if (result.status === 'error') throw result.failure
      return null
    })

  getSettings = (): Promise<RemoteResult<Settings>> =>
    this.result(async () => {
      const snapshot = await this.snapshot()
      const { defaultSettings } = await import('@openhome-ui/state/appInfo')
      return {
        ...structuredClone(this.uiSettings ?? defaultSettings),
        enabledPlugins: {},
        appTheme: (this.edit?.content ?? snapshot.vault.content).settings.theme,
      }
    })

  updateSettings = (settings: Settings): Promise<RemoteResult<null>> =>
    this.result(async () => {
      if (Object.values(settings.enabledPlugins).some(Boolean))
        unavailable('updateSettings', 'remote plugins are disabled')
      const edit = await this.ensureEdit()
      this.applyStaged(edit, [
        { op: 'settings_put', settings: { ...edit.content.settings, theme: settings.appTheme } },
      ])
      this.uiSettings = structuredClone(settings)
      return null
    })

  setTheme = (theme: AppTheme): Promise<RemoteResult<null>> =>
    this.result(async () => {
      const edit = await this.ensureEdit()
      this.applyStaged(edit, [
        { op: 'settings_put', settings: { ...edit.content.settings, theme } },
      ])
      return null
    })

  getConvertStrategies = () => this.reject<ConvertStrategies>('getConvertStrategies')
  updateConvertStrategies = (_strategies: ConvertStrategyEntries) =>
    this.reject<null>('updateConvertStrategies')
  loadItemBag = async (): Promise<ItemBag> => {
    throw this.recordError(new RemoteError('unavailable', unavailableOperations.loadItemBag))
  }
  saveItemBag = (_items: ItemBag) => this.reject<null>('saveItemBag')

  getState = (): Promise<RemoteResult<AppState>> =>
    Promise.resolve({
      status: 'ok',
      data: {
        is_dev: false,
        new_features_since_update: [],
        transaction: { open_transaction: this.edit !== undefined, temp_files: [] },
      },
    })

  pickFile = () => this.result(this.files.pickFile)
  pickFolder = () => this.result(this.files.pickFolder)
  loadSaveFile: BackendInterface['loadSaveFile'] = (path) =>
    this.result(() => this.files.loadSaveFile(path))
  saveLocalFile: BackendInterface['saveLocalFile'] = (bytes, name) =>
    this.result(() => this.files.saveLocalFile(bytes, name))
  writeSaveFile: BackendInterface['writeSaveFile'] = (path, bytes) =>
    this.result(() => {
      if (this.edit)
        unavailable(
          'writeSaveFile',
          'a local file and server vault cannot commit atomically; use the verified transfer protocol'
        )
      return this.files.writeSaveFile(path, bytes)
    })
  writeAllSaveFiles = async (writers: SaveWriter[]) =>
    Promise.all(
      writers.map((writer) =>
        this.result(() => {
          if (this.edit)
            unavailable(
              'writeAllSaveFiles',
              'a local save and server vault cannot commit atomically; use the verified transfer protocol'
            )
          return this.files.writeSaveFile(writer.filepath, writer.bytes)
        })
      )
    )
  getRecentSaves = () => this.result(this.files.getRecentSaves)
  addRecentSave: BackendInterface['addRecentSave'] = (save) =>
    this.result(() => this.files.addRecentSave(save))
  removeRecentSave: BackendInterface['removeRecentSave'] = (path) =>
    this.result(() => this.files.removeRecentSave(path))
  findSuggestedSaves = () => this.result(this.files.findSuggestedSaves)
  getSaveFolders = () => this.result(this.files.getSaveFolders)
  upsertSaveFolder: BackendInterface['upsertSaveFolder'] = (path, label) =>
    this.result(() => this.files.upsertSaveFolder(path, label))
  removeSaveFolder: BackendInterface['removeSaveFolder'] = (path) =>
    this.result(() => this.files.removeSaveFolder(path))
  openDirectory: BackendInterface['openDirectory'] = (path) =>
    this.result(() => this.files.openDirectory(path))
  openFileLocation: BackendInterface['openFileLocation'] = (path) =>
    this.result(() => this.files.openFileLocation(path))
  getResourcesPath = this.files.getResourcesPath
  convertLocalImagePath = this.files.convertLocalImagePath
  getPlatform = this.files.getPlatform

  registerListeners = (listeners: Partial<BackendListeners>): (() => void) => {
    if (listeners.onPluginDownloadProgress)
      unavailable('onPluginDownloadProgress', 'remote plugins are disabled')
    if (
      Object.keys(listeners.onStateUpdate ?? {}).some(
        (key) => key !== 'vault' && key !== 'remote_connection'
      )
    ) {
      unavailable(
        'onStateUpdate',
        'remote state listeners expose only vault and remote_connection, not desktop synced-state IPC'
      )
    }
    this.listeners.add(listeners)
    this.publishCollection()
    return () => this.listeners.delete(listeners)
  }

  onMenuEvent = (event: MenuEvent, listener: () => void): (() => void) =>
    this.onMenuEvents({ [event]: listener })

  onMenuEvents = (
    callbacks: Partial<Record<MenuEvent, () => NowOrLater<unknown>>>
  ): (() => void) => {
    const registered: [MenuEvent, () => NowOrLater<unknown>][] = []
    for (const event of ['save', 'reset', 'open', 'zoom_in', 'zoom_out', 'reset_zoom'] as const) {
      const callback = callbacks[event]
      if (!callback) continue
      const listeners = this.menuListeners.get(event) ?? new Set()
      listeners.add(callback)
      this.menuListeners.set(event, listeners)
      registered.push([event, callback])
    }
    return () => {
      for (const [event, callback] of registered) this.menuListeners.get(event)?.delete(callback)
    }
  }

  emitMenuEvent = async (event: string): Promise<void> => {
    if (!isMenuEvent(event))
      unavailable('emitMenuEvent', 'only client-local menu events are supported')
    for (const callback of this.menuListeners.get(event) ?? []) await callback()
    for (const listener of this.listeners) listener.onMenuEvent?.(event)
  }

  getLogs = (_filter: LogFilter) => this.reject<never>('getLogs')
  log = (_level: LogLevel, _message: string, _context?: Record<string, unknown>) =>
    this.reject<void>('log')
  clearLogsForRange = (_start: Dayjs, _end: Dayjs) => this.reject<null>('clearLogsForRange')
  onNewLog: BackendInterface['onNewLog'] = () =>
    unavailable('onNewLog', unavailableOperations.onNewLog)
  listInstalledPlugins = () => this.reject<never>('listInstalledPlugins')
  getPluginPath = (_pluginId: string) => this.reject<string>('getPluginPath')
  downloadPlugin = (_url: string) => this.reject<string>('downloadPlugin')
  loadPluginCode = (_id: string) => this.reject<string>('loadPluginCode')
  deletePlugin = (_id: string) => this.reject<null>('deletePlugin')
}

function isMenuEvent(event: string): event is MenuEvent {
  return ['save', 'reset', 'open', 'zoom_in', 'zoom_out', 'reset_zoom'].includes(event)
}
