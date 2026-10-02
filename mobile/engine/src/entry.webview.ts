// Must stay the first import: it swaps in the storage shim before lib loads.
import { engineStorage, misroutedStorageKeys } from './install-shims'
// Second: installs the WASM source before any SDK code can ask for it.
import './wasm-source'
import { createEngineApi } from './api'
import { createDispatcher } from './rpc/dispatcher'
import { createWebViewTransport } from './rpc/transport'
import { dispatchConnectivity, dispatchLifecycle } from './shims/lifecycle'
import { bundleHash } from './build-info'
import { LOG_LEVELS, type LogLevel } from './protocol/envelope'
import initWasm from './shims/wasm-sdk'
import { avatarStyles } from './avatar-source'
import { preconnectQuorumService } from './preconnect'

/**
 * The engine inside the hidden WebView. Serves the API over the
 * react-native-webview bridge, writes storage through to the host, forwards
 * console output at or above the forwarding level (the WebView console is
 * invisible in release builds) and announces readiness with `engine.hello`.
 */

let forwardFrom: LogLevel = 'info'

const dispatcher = createDispatcher({
  api: createEngineApi({
    lifecycle: dispatchLifecycle,
    connectivity: dispatchConnectivity,
    setLogLevel: level => { forwardFrom = level },
    // Called only after construction (nothing emits while the API is built).
    emit: (event, payload) => dispatcher.emit(event, payload),
    secureDurable: () => engineStorage.secureDurable(),
  }),
  transport: createWebViewTransport(),
  onStorageAck: seq => engineStorage.ack(seq),
})

engineStorage.onBatch(batch => dispatcher.storage(batch))
if (misroutedStorageKeys.length > 0) {
  dispatcher.log('warn', `Storage snapshot filed ${misroutedStorageKeys.length} key(s) under the wrong area; rerouted by prefix: ${misroutedStorageKeys.join(', ')}`)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item))
  } catch {
    return String(value)
  }
}

/** tslog styles browser output with %c directives; drop them and the CSS arguments they consume. */
function formatConsoleArgs(args: unknown[]): string {
  const [first, ...rest] = args
  if (typeof first === 'string' && first.includes('%c')) {
    const styles = first.split('%c').length - 1
    return [first.replace(/%c/g, ''), ...rest.slice(styles)].map(describe).join(' ')
  }
  return args.map(describe).join(' ')
}

const levels: Record<'debug' | 'log' | 'info' | 'warn' | 'error', LogLevel> = {
  debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error',
}
for (const [method, level] of Object.entries(levels) as [keyof typeof levels, LogLevel][]) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => {
    original(...args)
    // Filtered before formatting: on devnet (NEXT_PUBLIC_LOG_LEVEL=debug) lib logs a lot.
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(forwardFrom)) return
    try {
      dispatcher.log(level, formatConsoleArgs(args))
    } catch {
      // Logging must never break the engine.
    }
  }
}

dispatcher.hello({ bundleHash: bundleHash() })

// Start on the WASM now rather than at engine.boot(): it streams in and compiles
// while the hello crosses the bridge and the host answers. boot() joins this
// init and reports a failure.
initWasm().catch((error: unknown) => dispatcher.log('error', `The WASM did not load: ${describe(error)}`))

avatarStyles.catch((error: unknown) => dispatcher.log('error', `Avatar styles did not load: ${describe(error)}`))

try {
  preconnectQuorumService()
} catch (error) {
  // Only an optimization: the SDK reports a bad quorum URL itself.
  dispatcher.log('warn', `Quorum preconnect skipped: ${describe(error)}`)
}
