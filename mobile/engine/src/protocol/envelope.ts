/**
 * Wire envelopes between the React Native host and the engine.
 *
 * Every message is one JSON string: `JSON.stringify(encode(envelope))`, so the
 * values inside (`args`, `value`, `payload`) keep their Date, Uint8Array,
 * bigint, Map, Set, undefined and Error types (see ./codec.ts).
 *
 * This module and ./codec.ts are dependency-free on purpose: the RN app
 * imports them at runtime, so they must not reach `lib/` or `@dashevo/*`.
 */

/**
 * Bumped on any breaking change to the envelopes or the codec tags. The engine
 * announces its version in the `engine.hello` event and refuses requests that
 * carry another one, so a stale engine bundle fails loudly instead of
 * misreading messages.
 */
export const PROTOCOL_VERSION = 1

/** Host → engine: call `path` (e.g. `feed.forYou`) with `args`. */
export interface RequestEnvelope {
  t: 'req'
  v: number
  id: string
  path: string
  args: unknown[]
}

/** Host → engine: ask the engine to re-send `engine.hello` (a client created after the first one). */
export interface PingEnvelope {
  t: 'ping'
  v: number
}

/**
 * An Error carried across the bridge. `message` is verbatim, so lib/error-utils
 * classifiers still match it; `code`, `kind` and `isRetriable` are evo-sdk's
 * WasmSdkError fields (consensus codes, timeout kinds).
 */
export interface SerializedError {
  name: string
  message: string
  code?: string | number
  kind?: string | number
  isRetriable?: boolean
  stack?: string
  cause?: SerializedError
  /** Own enumerable fields beyond the standard ones, when they were encodable. */
  data?: Record<string, unknown>
}

/** Engine → host: the outcome of one request. */
export type ResponseEnvelope =
  | { t: 'res'; v: number; id: string; ok: true; value: unknown }
  | { t: 'res'; v: number; id: string; ok: false; error: SerializedError }

/** Engine → host: an unsolicited event (storage write-through, hello). */
export interface EventEnvelope {
  t: 'evt'
  v: number
  event: string
  payload: unknown
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** Engine → host: a forwarded console line (the WebView console is otherwise invisible). */
export interface LogEnvelope {
  t: 'log'
  v: number
  level: LogLevel
  message: string
}

export type Envelope = RequestEnvelope | PingEnvelope | ResponseEnvelope | EventEnvelope | LogEnvelope

/** Payload of the `engine.hello` event, sent once the engine can take requests and on every ping. */
export interface EngineHello {
  protocol: number
  bundleHash: string
  /** New on every engine load: a hello with another id means the engine restarted. */
  instanceId: string
}

/** Error codes the RPC layer itself produces (SDK errors keep their own). */
export const RpcErrorCode = {
  ProtocolMismatch: 'PROTOCOL_MISMATCH',
  UnknownMethod: 'UNKNOWN_METHOD',
  BadEnvelope: 'BAD_ENVELOPE',
  Timeout: 'RPC_TIMEOUT',
  HelloTimeout: 'ENGINE_HELLO_TIMEOUT',
  Restarted: 'ENGINE_RESTARTED',
  Disconnected: 'ENGINE_DISCONNECTED',
} as const

export type RpcErrorCodeValue = (typeof RpcErrorCode)[keyof typeof RpcErrorCode]

/** An error raised by the RPC layer or the engine itself, carrying one of `RpcErrorCode` or an engine code. */
export class RpcError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'RpcError'
  }
}
