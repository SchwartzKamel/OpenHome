import {
  type ApiResponse,
  type PreparedRequest,
  RemoteBackend,
  RemoteError,
} from '@openhome-core/remote'
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

type ReportSafety = (key: string, blocked: boolean) => void
const SafetyContext = createContext<ReportSafety>(() => undefined)

export function SafetyProvider({ report, children }: PropsWithChildren<{ report: ReportSafety }>) {
  return <SafetyContext value={report}>{children}</SafetyContext>
}

export function useSafety(blocked: boolean) {
  const report = useContext(SafetyContext)
  const id = useId()
  useLayoutEffect(() => {
    report(id, blocked)
    return () => report(id, false)
  }, [report, id, blocked])
}

export function useConnection(backend: RemoteBackend) {
  const [state, setState] = useState(() => ({
    connection: backend.connection,
    generation: backend.api.generation,
  }))
  useEffect(() => {
    const update = () =>
      setState({ connection: backend.connection, generation: backend.api.generation })
    const unsubscribe = backend.subscribe(update)
    update()
    return unsubscribe
  }, [backend])
  return state
}

export function safeFailure(error: unknown): RemoteError {
  return error instanceof RemoteError
    ? error
    : new RemoteError('protocol_error', 'The operation could not be completed.')
}

export function usePreparedAction<T>(
  backend: RemoteBackend,
  onSuccess: (response: ApiResponse<T>) => void,
  credentialExchange = false,
  admit?: () => string | undefined
) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<RemoteError>()
  const [retained, setRetained] = useState(false)
  const [retryAt, setRetryAt] = useState(0)
  const [admissionProblem, setAdmissionProblem] = useState<string>()
  const request = useRef<PreparedRequest<T>>(undefined)
  const uncertain = useRef(false)
  const running = useRef(false)
  const mounted = useRef(true)
  const success = useRef(onSuccess)
  const admission = useRef(admit)
  success.current = onSuccess
  admission.current = admit
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useSafety(busy || retained)

  const send = async (prepare?: () => PreparedRequest<T> | Promise<PreparedRequest<T>>) => {
    if (running.current || Date.now() < retryAt || (!prepare && !request.current)) return
    if (prepare && request.current) return
    running.current = true
    setBusy(true)
    setAdmissionProblem(undefined)
    const generation = backend.api.generation
    let activatedGeneration: number | undefined
    const unsubscribe = credentialExchange
      ? backend.api.subscribeCredentials(() => {
          if (activatedGeneration === undefined && backend.api.authenticated)
            activatedGeneration = backend.api.generation
        })
      : undefined
    try {
      if (prepare) request.current = await prepare()
      if (!mounted.current || generation !== backend.api.generation)
        throw new RemoteError('cancelled', 'The authenticated identity changed.')
      if (!request.current) return
      setRetained(true)
      const problem = admission.current?.()
      if (problem) {
        setAdmissionProblem(problem)
        return
      }
      if (!uncertain.current) setFailure(undefined)
      const response = await request.current.send()
      if (!mounted.current || (!credentialExchange && generation !== backend.api.generation)) return
      if (credentialExchange && activatedGeneration !== backend.api.generation)
        throw new RemoteError('cancelled', 'A newer identity replaced this credential response.')
      request.current = undefined
      uncertain.current = false
      setFailure(undefined)
      setRetained(false)
      setRetryAt(0)
      success.current(response)
    } catch (error) {
      if (!mounted.current) return
      let problem = safeFailure(error)
      if (problem.code === 'unauthorized' || problem.code === 'cancelled') {
        request.current = undefined
        uncertain.current = false
        setRetained(false)
      } else {
        uncertain.current ||= problem.uncertain
        if (uncertain.current && !problem.uncertain) {
          problem = new RemoteError(
            problem.code,
            problem.message,
            problem.httpStatus,
            problem.details,
            true,
            problem.retryAfterSeconds
          )
        }
        setRetained(request.current !== undefined)
      }
      setFailure(problem)
      setRetryAt(problem.retryAfterSeconds ? Date.now() + problem.retryAfterSeconds * 1000 : 0)
    } finally {
      unsubscribe?.()
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return {
    busy,
    failure,
    retained,
    retryAt,
    admissionProblem,
    start: (prepare: () => PreparedRequest<T> | Promise<PreparedRequest<T>>) => send(prepare),
    retry: () => send(),
    reset: () => {
      if (running.current || uncertain.current) return
      request.current = undefined
      setRetained(false)
      setFailure(undefined)
      setRetryAt(0)
      setAdmissionProblem(undefined)
    },
  }
}

export type PreparedAction<T> = ReturnType<typeof usePreparedAction<T>>

export function usePrivateRead<T>(backend: RemoteBackend) {
  const [data, setData] = useState<T>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<RemoteError>()
  const serial = useRef(0)
  useEffect(
    () => () => {
      serial.current++
    },
    [backend]
  )
  useSafety(busy)
  const run = async (read: () => Promise<T>) => {
    const turn = ++serial.current
    const generation = backend.api.generation
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await read()
      if (turn === serial.current && generation === backend.api.generation) setData(result)
    } catch (error) {
      if (turn === serial.current && generation === backend.api.generation)
        setFailure(safeFailure(error))
    } finally {
      if (turn === serial.current && generation === backend.api.generation) setBusy(false)
    }
  }
  return { data, busy, failure, run, clear: () => setData(undefined) }
}
