import { parse, serializeError, stringify } from '../protocol/codec'
import {
  PROTOCOL_VERSION,
  RpcErrorCode,
  isEnvelope,
  type EngineHello,
  type Envelope,
  type LogLevel,
  type RequestEnvelope,
} from '../protocol/envelope'
import type { Transport } from './transport'

/** A tree of async methods, addressed by dotted path (`feed.forYou`). */
export interface ApiTree {
  [key: string]: ((...args: never[]) => unknown) | ApiTree
}

export interface DispatcherOptions {
  api: ApiTree
  transport: Transport
  /** Include stacks in serialized errors (diagnostics builds). */
  includeStacks?: boolean
}

export interface Dispatcher {
  /** Send an event to the host. */
  emit(event: string, payload: unknown): void
  /** Forward a log line to the host. */
  log(level: LogLevel, message: string): void
  /** Announce readiness: the host's client queues calls until this arrives. */
  hello(info: Omit<EngineHello, 'protocol'>): void
  dispose(): void
}

class RpcError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'RpcError'
  }
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

/** Serve `api` over `transport`: one response per request, in completion order. */
export function createDispatcher({ api, transport, includeStacks = false }: DispatcherOptions): Dispatcher {
  const send = (envelope: Envelope) => {
    transport.send(stringify(envelope, { includeStack: includeStacks }))
  }

  const fail = (id: string, error: unknown) => {
    const serialized = serializeError(error, undefined, { includeStack: includeStacks })
    try {
      send({ t: 'res', v: PROTOCOL_VERSION, id, ok: false, error: serialized })
    } catch {
      // Extra fields that cannot be encoded never cost the caller its error.
      send({ t: 'res', v: PROTOCOL_VERSION, id, ok: false, error: { ...serialized, data: undefined } })
    }
  }

  const handle = async (request: RequestEnvelope) => {
    if (request.v !== PROTOCOL_VERSION) {
      fail(request.id, new RpcError(
        `Engine speaks protocol ${PROTOCOL_VERSION}, request used ${request.v}`,
        RpcErrorCode.ProtocolMismatch
      ))
      return
    }
    try {
      const method = resolveMethod(api, request.path)
      const value = await method(...(Array.isArray(request.args) ? request.args : []))
      try {
        send({ t: 'res', v: PROTOCOL_VERSION, id: request.id, ok: true, value })
      } catch (encodeError) {
        // An unencodable result (a cycle) must still settle the caller.
        fail(request.id, encodeError)
      }
    } catch (error) {
      fail(request.id, error)
    }
  }

  const unsubscribe = transport.onMessage((message) => {
    let envelope: unknown
    try {
      envelope = parse(message)
    } catch {
      return
    }
    if (!isEnvelope(envelope) || envelope.t !== 'req') return
    if (typeof envelope.id !== 'string' || typeof envelope.path !== 'string') return
    handle(envelope).catch(() => {
      // handle() settles every request itself; nothing escapes to here.
    })
  })

  return {
    emit(event, payload) {
      send({ t: 'evt', v: PROTOCOL_VERSION, event, payload })
    },
    log(level, message) {
      send({ t: 'log', v: PROTOCOL_VERSION, level, message })
    },
    hello(info) {
      send({ t: 'evt', v: PROTOCOL_VERSION, event: 'engine.hello', payload: { protocol: PROTOCOL_VERSION, ...info } })
    },
    dispose: unsubscribe,
  }
}
