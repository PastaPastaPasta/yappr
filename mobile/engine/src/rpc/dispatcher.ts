import { decode, serializeError, stringify } from '../protocol/codec'
import {
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  type EngineHello,
  type Envelope,
  type KvOp,
  type LogLevel,
} from '../protocol/envelope'
import type { Transport } from './transport'

/** A tree of async methods, addressed by dotted path (`feed.home`). */
export interface ApiTree {
  [key: string]: ((...args: never[]) => unknown) | ApiTree
}

export interface DispatcherOptions {
  api: ApiTree
  transport: Transport
  /** Include stacks in serialized errors (diagnostics builds). */
  includeStacks?: boolean
  /** The host acknowledged the `skv` batch `seq`. */
  onStorageAck?: (seq: number) => void
}

export interface Dispatcher {
  /** Send an event to the host. */
  emit(event: string, payload: unknown): void
  /** Forward a log line to the host. */
  log(level: LogLevel, message: string): void
  /** Send a storage write-through batch (`kv` for the plain area, `skv` for the secure one). */
  storage(batch: { area: 'local' | 'secure'; seq: number; ops: KvOp[] }): void
  /** Announce readiness (and again on every ping): the host's client queues calls until it arrives. */
  hello(info: { bundleHash: string }): void
  dispose(): void
}

/**
 * Resolve `path` to a function on `api`, walking own properties only so a
 * request can never reach `__proto__`, `constructor` or inherited members.
 */
export function resolveMethod(api: ApiTree, path: string): (...args: unknown[]) => unknown {
  let node: unknown = api
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.prototype.hasOwnProperty.call(node, segment)) {
      throw new RpcError(`Unknown engine method: ${path}`, RpcErrorCode.UnknownMethod)
    }
    node = (node as Record<string, unknown>)[segment]
  }
  if (typeof node !== 'function') throw new RpcError(`Unknown engine method: ${path}`, RpcErrorCode.UnknownMethod)
  return node as (...args: unknown[]) => unknown
}

/** Distinguishes engine loads; no crypto needed, and `crypto.randomUUID` is absent in insecure contexts. */
const newInstanceId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Serve `api` over `transport`: one response per request, in completion order. */
export function createDispatcher({ api, transport, includeStacks = false, onStorageAck }: DispatcherOptions): Dispatcher {
  const instanceId = newInstanceId()
  let helloInfo: EngineHello | null = null

  const send = (envelope: Envelope) => {
    transport.send(stringify(envelope, { includeStack: includeStacks }))
  }

  const emit = (event: string, payload: unknown) => send({ t: 'evt', v: PROTOCOL_VERSION, event, payload })

  const fail = (id: string, error: unknown) => {
    const serialized = serializeError(error, undefined, { includeStack: includeStacks })
    try {
      send({ t: 'res', v: PROTOCOL_VERSION, id, ok: false, error: serialized })
    } catch {
      // Extra fields that cannot be encoded never cost the caller its error.
      send({ t: 'res', v: PROTOCOL_VERSION, id, ok: false, error: { ...serialized, data: undefined, cause: undefined } })
    }
  }

  const handle = async (id: string, path: string, args: unknown[]) => {
    try {
      const value = await resolveMethod(api, path)(...args)
      // An unencodable result (a cycle) throws here and is reported below.
      send({ t: 'res', v: PROTOCOL_VERSION, id, ok: true, value })
    } catch (error) {
      fail(id, error)
    }
  }

  const unsubscribe = transport.onMessage((message) => {
    // Decoded in stages, so a request whose arguments cannot be decoded still
    // gets an answer (BAD_ENVELOPE) instead of leaving its caller to time out.
    let raw: { t?: unknown; v?: unknown; id?: unknown; path?: unknown; args?: unknown; seq?: unknown; instance?: unknown }
    try {
      raw = JSON.parse(message)
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    if (raw.t === 'ping') {
      if (helloInfo) emit('engine.hello', helloInfo)
      return
    }
    if (raw.t === 'kv-ack') {
      if (typeof raw.seq === 'number') onStorageAck?.(raw.seq)
      return
    }
    if (raw.t !== 'req' || typeof raw.id !== 'string') return
    const id = raw.id
    if (raw.v !== PROTOCOL_VERSION) {
      fail(id, new RpcError(`Engine speaks protocol ${PROTOCOL_VERSION}, request used ${String(raw.v)}`, RpcErrorCode.ProtocolMismatch))
      return
    }
    if (raw.instance !== undefined && raw.instance !== instanceId) {
      fail(id, new RpcError('Request was addressed to a previous engine instance; not run', RpcErrorCode.Restarted))
      return
    }
    let args: unknown
    try {
      args = decode(raw.args)
    } catch (error) {
      fail(id, new RpcError(`Undecodable request: ${error instanceof Error ? error.message : String(error)}`, RpcErrorCode.BadEnvelope))
      return
    }
    if (typeof raw.path !== 'string' || !Array.isArray(args)) {
      fail(id, new RpcError('Malformed request envelope', RpcErrorCode.BadEnvelope))
      return
    }
    handle(id, raw.path, args).catch(() => {
      // fail()'s fallback send can still throw if the bridge is gone; nobody is left to tell.
    })
  })

  return {
    emit,
    log(level, message) {
      send({ t: 'log', v: PROTOCOL_VERSION, level, message })
    },
    storage({ area, seq, ops }) {
      send({ t: area === 'secure' ? 'skv' : 'kv', v: PROTOCOL_VERSION, seq, ops })
    },
    hello({ bundleHash }) {
      helloInfo = { protocol: PROTOCOL_VERSION, bundleHash, instanceId }
      emit('engine.hello', helloInfo)
    },
    dispose: unsubscribe,
  }
}
