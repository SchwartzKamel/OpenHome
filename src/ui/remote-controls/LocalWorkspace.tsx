import { BackendContext } from '@openhome-core/backend'
import type BackendInterface from '@openhome-core/backend/backendInterface'
import useBackend from '@openhome-core/backend/useBackend'
import { R } from '@openhome-core/util/functional'
import AppTabs from '@openhome-ui/AppTabs'
import { useTitledErrorDisplay } from '@openhome-ui/hooks/displayError'
import BanksAndBoxesProvider from '@openhome-ui/state-zustand/banks-and-boxes/Provider'
import { useBanksAndBoxes } from '@openhome-ui/state-zustand/banks-and-boxes/store'
import { AppStateProvider } from '@openhome-ui/state/app-state'
import { AppInfoContext, appInfoInitialState, appInfoReducer } from '@openhome-ui/state/appInfo'
import ConvertStrategiesProvider from '@openhome-ui/state/convert-strategies/ConvertStrategiesProvider'
import PokemonDndContext from '@openhome-ui/state/drag-and-drop/PokemonDndContext'
import {
  defaultMultiSelectState,
  MultiSelectContext,
  type MultiSelectState,
} from '@openhome-ui/state/drag-and-drop/useMultiSelect'
import { ErrorContext, errorReducer } from '@openhome-ui/state/error'
import { ItemBagProvider } from '@openhome-ui/state/items/ItemBagProvider'
import { LookupsProvider } from '@openhome-ui/state/lookups'
import { MouseContext, mouseReducer } from '@openhome-ui/state/mouse'
import PluginsProvider from '@openhome-ui/state/plugin/PluginProvider'
import { SavesProvider } from '@openhome-ui/state/saves'
import { Flex, Text } from '@radix-ui/themes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useReducer, useState } from 'react'

const ZOOM_CHANGE_PCT = 5
const ZOOM_MIN_PCT = 50
const ZOOM_MAX_PCT = 160
const REDIRECT_WEB_CONSOLE = false
const queryClient = new QueryClient()

// Keep the original desktop provider tree and 120-slot UI out of browser startup.
export default function LocalWorkspace({ backend }: { backend: BackendInterface }) {
  const [errorState, errorDispatch] = useReducer(errorReducer, {})
  return (
    <BackendContext value={backend}>
      <ErrorContext value={[errorState, errorDispatch]}>
        <QueryClientProvider client={queryClient}>
          <BanksAndBoxesProvider>
            <AppWithBackend />
          </BanksAndBoxesProvider>
        </QueryClientProvider>
      </ErrorContext>
    </BackendContext>
  )
}

function AppWithBackend() {
  const [mouseState, mouseDispatch] = useReducer(mouseReducer, { shift: false })
  const [multiSelectState, setMultiSelectState] =
    useState<MultiSelectState>(defaultMultiSelectState())
  const [appInfoState, appInfoDispatch] = useReducer(appInfoReducer, appInfoInitialState)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const { saveChanges } = useBanksAndBoxes()
  const backend = useBackend()
  const displayTitledError = useTitledErrorDisplay()
  const reloadSettings = useEffectEvent(backend.getSettings)
  const getPlatform = useEffectEvent(backend.getPlatform)
  const displayErrorEvent = useEffectEvent(displayTitledError)
  const onMenuEvent = useEffectEvent(backend.onMenuEvent)
  const saveChangesEvent = useEffectEvent(() => {
    saveChanges().catch(displayTitledError('Error saving changes'))
  })

  useEffect(() => {
    const stopListening = onMenuEvent('save', saveChangesEvent)
    return () => {
      stopListening()
    }
  }, [])

  useEffect(() => {
    if (appInfoState.error) return
    reloadSettings()
      .then(
        R.match(
          (settings) => appInfoDispatch({ type: 'load_settings', payload: settings }),
          displayErrorEvent('Error loading settings')
        )
      )
      .catch(console.error)
      .finally(() => setSettingsLoading(false))
  }, [appInfoState.error])

  useEffect(() => {
    if (getPlatform() !== 'windows') return
    const handler = (event: KeyboardEvent) => void buildKeyboardHandler(backend)(event)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [backend])

  const listenToMenuEvents = useEffectEvent(backend.onMenuEvents)
  useEffect(() => {
    const stopListening = listenToMenuEvents({
      zoom_in: () =>
        appInfoDispatch({
          type: 'set_zoom_level',
          payload: Math.min(appInfoState.settings.zoomLevel + ZOOM_CHANGE_PCT, ZOOM_MAX_PCT),
        }),
      zoom_out: () =>
        appInfoDispatch({
          type: 'set_zoom_level',
          payload: Math.max(appInfoState.settings.zoomLevel - ZOOM_CHANGE_PCT, ZOOM_MIN_PCT),
        }),
      reset_zoom: () => appInfoDispatch((() => ({ type: 'set_zoom_level', payload: 100 }))()),
    })
    return () => {
      stopListening()
    }
  }, [appInfoState.settings.zoomLevel])

  const getEnabledSaveTypes = useCallback(
    () =>
      appInfoState.officialSaveTypes
        .concat(appInfoState.extraSaveTypes)
        .filter((saveType) => appInfoState.settings.enabledSaveTypes[saveType.saveTypeID]),
    [appInfoState]
  )

  useEffect(() => {
    patchConsole(backend)
  }, [backend])

  return (
    <AppInfoContext value={[appInfoState, appInfoDispatch, getEnabledSaveTypes]}>
      <PluginsProvider>
        <AppStateProvider>
          <MouseContext value={[mouseState, mouseDispatch]}>
            <LookupsProvider>
              <ConvertStrategiesProvider>
                <ItemBagProvider>
                  <SavesProvider>
                    <MultiSelectContext value={[multiSelectState, setMultiSelectState]}>
                      <PokemonDndContext>
                        {settingsLoading ? (
                          <Flex width="100%" height="100vh" align="center" justify="center">
                            <Text size="9" weight="bold">
                              OpenHome
                            </Text>
                          </Flex>
                        ) : (
                          <AppTabs />
                        )}
                      </PokemonDndContext>
                    </MultiSelectContext>
                  </SavesProvider>
                </ItemBagProvider>
              </ConvertStrategiesProvider>
            </LookupsProvider>
          </MouseContext>
        </AppStateProvider>
      </PluginsProvider>
    </AppInfoContext>
  )
}

const webConsole = { ...console }

function patchConsole(backend: BackendInterface) {
  if (!REDIRECT_WEB_CONSOLE) return
  const levels = [
    ['log', 'INFO'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
    ['debug', 'DEBUG'],
  ] as const
  for (const [method, level] of levels) {
    console[method] = (...args: unknown[]) => {
      if (args?.[0] === 'CONSOLE_ONLY') {
        webConsole[method](...args.slice(1))
        return
      }
      webConsole[method](...args)
      const stack = new Error().stack?.split('\n').slice(1)
      const callsite = stack?.[0]
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
        const context = args[0] as Record<string, unknown>
        context['callsite'] = callsite
        void backend.log(level, serializeArg(args.at(1)), JSON.parse(JSON.stringify(context)))
      } else {
        void backend.log(level, formatWithPlaceholders(args), { callsite })
      }
    }
  }
}

function formatWithPlaceholders(args: unknown[]): string {
  if (typeof args[0] !== 'string' || !args[0].includes('%')) return args.map(serializeArg).join(' ')
  let index = 1
  const formatted = args[0].replace(/%[sdifoO]/g, (token) => {
    if (index >= args.length) return token
    const value = args[index++]
    if (token === '%d' || token === '%i') return String(Number(value))
    if (token === '%f') return String(parseFloat(String(value)))
    if (token === '%o' || token === '%O') return JSON.stringify(value)
    return String(value)
  })
  return [formatted, ...args.slice(index).map(serializeArg)].join(' ')
}

function serializeArg(arg: unknown): string {
  // oxlint-disable-next-line typescript/no-base-to-string
  return typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
}

function buildKeyboardHandler(backend: BackendInterface) {
  return async (event: KeyboardEvent) => {
    if (!event.ctrlKey) return
    switch (event.key) {
      case 'o':
        return backend.emitMenuEvent('open')
      case 's':
        return backend.emitMenuEvent('save')
      case 't':
        return backend.emitMenuEvent('reset')
      case 'd':
        return backend.emitMenuEvent('open-appdata')
      case 'q':
        return backend.emitMenuEvent('exit')
      case 'u':
        return backend.emitMenuEvent('check-updates')
      case 'g':
        return backend.emitMenuEvent('visit-github')
    }
  }
}
