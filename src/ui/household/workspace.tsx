import {
  RemoteError,
  type ApiResponse,
  type PokemonRecord,
  type PreparedRequest,
  type RemoteBackend,
  type RemoteResult,
  type VaultCommand,
  type VaultContent,
  type VaultState,
} from '@openhome-core/remote'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { rebaseContent } from './model'

export interface WorkspaceData {
  vault: VaultState
  records: PokemonRecord[]
}

export interface IntentState {
  label: string
  key?: string
  operation: string
  sending: boolean
  uncertain: boolean
}

export function toError(error: unknown): RemoteError {
  return error instanceof RemoteError
    ? error
    : new RemoteError('protocol_error', error instanceof Error ? error.message : 'Operation failed')
}

export function resultValue<T>(result: RemoteResult<T>): T {
  if (result.status === 'error') throw result.failure
  return result.data
}

export function useWorkspaceState(
  backend: RemoteBackend,
  onPendingChange?: (pending: boolean) => void
) {
  const generation = backend.api.generation
  const [connection, setConnection] = useState(backend.connection)
  const [data, setData] = useState<WorkspaceData>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RemoteError>()
  const [notice, setNotice] = useState('')
  const [intent, setIntent] = useState<IntentState>()
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(new Set())
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const base = useRef<VaultContent | undefined>(undefined)
  const pending = useRef<{ retry: () => Promise<void>; state: IntentState } | undefined>(undefined)
  const isCurrent = useCallback(
    () => mounted.current && backend.api.generation === generation && backend.api.authenticated,
    [backend, generation]
  )
  const report = useCallback(
    (failure: unknown) => {
      if (isCurrent()) setError(toError(failure))
    },
    [isCurrent]
  )
  const announce = useCallback(
    (message: string) => {
      if (isCurrent()) setNotice(message)
    },
    [isCurrent]
  )
  const dirty = useCallback((key: string, value: boolean) => {
    setDrafts((previous) => {
      if (previous.has(key) === value) return previous
      const next = new Set(previous)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const readRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    mounted.current = true
    let active = true
    let reading: Promise<void> | undefined
    let requested = false
    const current = () =>
      active && backend.api.generation === generation && backend.api.authenticated
    const read = (): Promise<void> => {
      requested = true
      if (reading) return reading
      if (!current()) return Promise.resolve()
      reading = (async () => {
        try {
          do {
            requested = false
            const [vault, records] = await Promise.all([backend.getVault(), backend.getRecords()])
            if (!current()) return
            setData({ vault: resultValue(vault), records: resultValue(records) })
            setLoading(false)
          } while (requested && current())
        } catch (failure) {
          if (current()) {
            setError(toError(failure))
            setLoading(false)
          }
        }
      })().finally(() => {
        reading = undefined
      })
      return reading
    }
    readRef.current = read
    const unsubscribe = backend.subscribe(() => {
      if (!current()) return
      const next = backend.connection
      setConnection(next)
      if (next.coherent || next.editing) void read()
    })
    void read()
    return () => {
      active = false
      mounted.current = false
      unsubscribe()
    }
  }, [backend, generation])

  const guarded = busy || !!intent || drafts.size > 0
  useLayoutEffect(() => {
    onPendingChange?.(guarded)
  }, [guarded, onPendingChange])
  useLayoutEffect(() => () => onPendingChange?.(false), [onPendingChange])

  const local = useCallback(
    async (operation: () => Promise<unknown>) => {
      if (busyRef.current || pending.current || !isCurrent()) return false
      busyRef.current = true
      setBusy(true)
      setError(undefined)
      setNotice('')
      try {
        await operation()
        return true
      } catch (failure) {
        report(failure)
        return false
      } finally {
        if (isCurrent()) {
          setConnection(backend.connection)
          await readRef.current()
          if (isCurrent()) setBusy(false)
        }
        busyRef.current = false
      }
    },
    [backend, isCurrent, report]
  )

  const refresh = useCallback(async () => {
    resultValue(await backend.resync())
    if (isCurrent()) {
      setConnection(backend.connection)
      await readRef.current()
    }
  }, [backend, isCurrent])

  const stage = useCallback(
    async (commands: VaultCommand[]) => {
      if (!data || backend.connection.uncertain) return false
      const original = structuredClone(data.vault.content)
      return local(async () => {
        resultValue(await backend.stageCommands(commands))
        base.current ??= original
        announce('Changes staged locally. Save changes to commit them to the household vault.')
      })
    },
    [announce, backend, data, local]
  )

  const save = useCallback(
    () =>
      local(async () => {
        resultValue(await backend.commitTransaction())
        base.current = undefined
        announce(
          `Save acknowledged at revision ${backend.connection.lastCommittedRevision ?? 'unknown'}.`
        )
      }),
    [announce, backend, local]
  )

  const rollback = useCallback(
    () =>
      local(async () => {
        resultValue(await backend.rollbackTransaction())
        base.current = undefined
        announce(
          'Staged changes rolled back. Previously acknowledged COPY imports are still owned.'
        )
      }),
    [announce, backend, local]
  )

  const rebase = useCallback(
    () =>
      local(async () => {
        const original = base.current
        if (!original)
          throw new RemoteError(
            'unavailable',
            'This edit buffer has no local rebase baseline; roll back and restage it.'
          )
        let latest: VaultContent | undefined
        resultValue(
          await backend.rebaseTransaction((current, staged) => {
            const merged = rebaseContent(original, current, staged)
            latest = structuredClone(current)
            return merged
          })
        )
        base.current = latest
        announce(
          'Three-way rebase staged. Unrelated server changes were preserved; review and save explicitly.'
        )
      }),
    [announce, backend, local]
  )

  const mutate = useCallback(
    async <T,>(
      label: string,
      prepare: () => PreparedRequest<T>,
      accept: (response: ApiResponse<T>) => void | Promise<void>
    ): Promise<void> => {
      if (busyRef.current || pending.current || !isCurrent()) return
      let request: PreparedRequest<T>
      try {
        request = prepare()
      } catch (failure) {
        report(failure)
        return
      }
      const state: IntentState = {
        label,
        key: request.idempotencyKey,
        operation: request.operation,
        sending: false,
        uncertain: false,
      }
      const retry = async () => {
        if (!isCurrent() || state.sending) return
        state.sending = true
        setIntent({ ...state })
        setError(undefined)
        let response: ApiResponse<T>
        try {
          response = await request.send()
        } catch (failure) {
          if (!isCurrent()) return
          const detail = toError(failure)
          state.uncertain ||= detail.uncertain
          state.sending = false
          if (state.uncertain) setIntent({ ...state })
          else {
            pending.current = undefined
            setIntent(undefined)
          }
          report(detail)
          return
        }
        if (!isCurrent()) return
        pending.current = undefined
        setIntent(undefined)
        busyRef.current = true
        setBusy(true)
        announce(`${label} acknowledged. No new mutation is needed to refresh its result.`)
        try {
          await accept(response)
        } catch (failure) {
          report(failure)
        } finally {
          busyRef.current = false
          if (isCurrent()) setBusy(false)
        }
      }
      pending.current = { retry, state }
      await retry()
    },
    [announce, isCurrent, report]
  )

  const retryIntent = useCallback(async () => {
    await pending.current?.retry()
  }, [])
  return {
    backend,
    connection,
    data,
    loading,
    busy,
    error,
    notice,
    intent,
    isCurrent,
    report,
    announce,
    dirty,
    local,
    refresh,
    stage,
    save,
    rollback,
    rebase,
    mutate,
    retryIntent,
    locked: busy || !!intent || connection.uncertain,
    durableBlocked: busy || !!intent || connection.editing || !connection.coherent,
    canRebase: !!base.current,
  }
}

export type HouseholdState = ReturnType<typeof useWorkspaceState>
const Context = createContext<HouseholdState | undefined>(undefined)

export function HouseholdProvider({
  value,
  children,
}: {
  value: HouseholdState
  children: ReactNode
}) {
  return <Context value={value}>{children}</Context>
}

export function useHousehold(): HouseholdState {
  const value = useContext(Context)
  if (!value) throw new Error('Household controls require their workspace')
  return value
}

export function usePrivateDraft(key: string, pending: boolean) {
  const { dirty } = useHousehold()
  // Passive registration can expose idle controls before a just-read upload
  // reaches the parent's navigation guard.
  useLayoutEffect(() => {
    dirty(key, pending)
    return () => dirty(key, false)
  }, [dirty, key, pending])
}
