import { RemoteError, decode, stringify } from '../protocol/codec'
import {
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  type EngineHello,
  type LogLevel,
  type SerializedError,
} from '../protocol/envelope'
import type { Transport } from './transport'

/** `T` as seen from the host: every method returns a Promise of its awaited result. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K] extends object ? Remote<T[K]> : never
}

export interface ClientOptions {
  /**
   * Per-call deadline, counted from the call (time spent waiting for the
   * engine's hello included); 0 disables it. Default 60 s: a feed page can
   * chain several DAPI round trips.
   */
  timeoutMs?: number
  /** How long to wait for the first `engine.hello` before failing the client; 0 waits forever. Default 30 s. */
  helloTimeoutMs?: number
  onLog?: (level: LogLevel, message: string) => void
}

export interface EngineClient<T> {
  api: Remote<T>
  /** Resolves with the engine's first hello; calls made earlier are queued until then. */
  ready: Promise<EngineHello>
  /** Engine events, plus `engine.hello` on every (re)announcement. */
  on(event: string, handler: (payload: unknown) => void): () => void
  /** Ask the engine to announce itself again (it answers with `engine.hello`). */
  ping(): void
  /** Reject every pending call (the engine process died) and stop listening. */
  close(reason?: string): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Property names the Proxy must not turn into calls: Promise resolution,
 * coercion, and what loggers, inspectors and React probe on any object.
 */
const NOT_METHODS = new Set([
  'then', 'catch', 'finally', 'toString', 'valueOf', 'toJSON', 'constructor', 'inspect',
  '$$typeof', 'nodeType', 'asymmetricMatch', 'prototype', 'length', 'name', 'call', 'apply', 'bind',
])

/**
 * The host side of the RPC. `api` is a Proxy: `client.api.feed.forYou(x)`
 * sends `{ path: 'feed.forYou', args: [x] }`, so adding an engine method
 * needs no change here.
 *
 * Handshake: calls wait for `engine.hello` (the client pings on creation in
 * case the engine announced itself before this client existed). A hello with
 * another protocol, or none within `helloTimeoutMs`, fails the client. A
 * hello from a new engine instance (the WebView reloaded) rejects every
 * pending call with ENGINE_RESTARTED; reads may be retried, writes must go
 * through the unconfirmed-writes rules.
 */
export function createEngineClient<T>(transport: Transport, options: ClientOptions = {}): EngineClient<T> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const helloTimeoutMs = options.helloTimeoutMs ?? 30_000
  const pending = new Map<string, Pending>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let nextId = 0
  let closed: RpcError | null = null
  let current: EngineHello | null = null

  let markReady!: (hello: EngineHello) => void
  let markFailed!: (error: Error) => void
  const ready = new Promise<EngineHello>((resolve, reject) => {
    markReady = resolve
    markFailed = reject
  })
  // A failed handshake is reported through each call; this keeps it from
  // also surfacing as an unhandled rejection when nobody awaits `ready`.
  ready.catch(() => undefined)

  /** Remove a pending call (clearing its timer) and hand it back, once. */
  const take = (id: string): Pending | undefined => {
    const entry = pending.get(id)
    if (!entry) return undefined
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    return entry
  }

  const rejectAll = (error: Error) => {
    for (const id of [...pending.keys()]) take(id)?.reject(error)
  }

  const shutdown = (error: RpcError) => {
    if (closed) return
    closed = error
    clearTimeout(helloTimer)
    unsubscribe()
    markFailed(error)
    rejectAll(error)
  }

  const helloTimer = helloTimeoutMs > 0
    ? setTimeout(() => shutdown(new RpcError(`Engine did not say hello within ${helloTimeoutMs} ms`, RpcErrorCode.HelloTimeout)), helloTimeoutMs)
    : undefined

  const onHello = (hello: EngineHello) => {
    if (hello.protocol !== PROTOCOL_VERSION) {
      shutdown(new RpcError(`Engine speaks protocol ${hello.protocol}, host expects ${PROTOCOL_VERSION}`, RpcErrorCode.ProtocolMismatch))
      return
    }
    if (!current) {
      current = hello
      clearTimeout(helloTimer)
      markReady(hello)
    } else if (hello.instanceId !== current.instanceId) {
      current = hello
      rejectAll(new RpcError('Engine restarted', RpcErrorCode.Restarted))
    }
  }

  const unsubscribe = transport.onMessage((message) => {
    // Decoded in stages: a response whose value cannot be decoded still
    // settles its call (BAD_ENVELOPE) instead of leaving it to time out.
    let raw: { t?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: unknown; event?: unknown; payload?: unknown; level?: unknown; message?: unknown }
    try {
      raw = JSON.parse(message)
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    switch (raw.t) {
      case 'res': {
        if (typeof raw.id !== 'string') return
        const entry = take(raw.id)
        if (!entry) return
        try {
          if (raw.ok === true) entry.resolve(decode(raw.value))
          else entry.reject(new RemoteError(decode(raw.error) as SerializedError))
        } catch (error) {
          entry.reject(new RpcError(`Undecodable response: ${error instanceof Error ? error.message : String(error)}`, RpcErrorCode.BadEnvelope))
        }
        return
      }
      case 'evt': {
        if (typeof raw.event !== 'string') return
        let payload: unknown
        try {
          payload = decode(raw.payload)
        } catch {
          return
        }
        if (raw.event === 'engine.hello') onHello(payload as EngineHello)
        listeners.get(raw.event)?.forEach(handler => handler(payload))
        return
      }
      case 'log':
        if (typeof raw.level === 'string' && typeof raw.message === 'string') options.onLog?.(raw.level as LogLevel, raw.message)
        return
    }
  })

  const ping = () => {
    try {
      transport.send(JSON.stringify({ t: 'ping', v: PROTOCOL_VERSION }))
    } catch {
      // The engine is not loaded yet; it says hello by itself when it is.
    }
  }

  const call = (path: string, args: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed) {
      reject(new RpcError(closed.message, RpcErrorCode.Disconnected))
      return
    }
    const id = String(++nextId)
    const entry: Pending = { resolve, reject }
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        take(id)?.reject(new RpcError(`Engine call ${path} timed out after ${timeoutMs} ms`, RpcErrorCode.Timeout))
      }, timeoutMs)
    }
    pending.set(id, entry)
    ready
      .then(() => {
        if (pending.has(id)) transport.send(stringify({ t: 'req', v: PROTOCOL_VERSION, id, path, args }))
      })
      .catch((error: unknown) => take(id)?.reject(error))
  })

  const proxyAt = (path: string[]): unknown => new Proxy(() => undefined, {
    get(_target, key) {
      if (typeof key !== 'string' || NOT_METHODS.has(key)) return undefined
      return proxyAt([...path, key])
    },
    apply(_target, _this, args: unknown[]) {
      return call(path.join('.'), args)
    },
  })

  ping()

  return {
    api: proxyAt([]) as Remote<T>,
    ready,
    on(event, handler) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, set = new Set())
      set.add(handler)
      return () => { set.delete(handler) }
    },
    ping,
    close(reason = 'Engine connection closed') {
      shutdown(new RpcError(reason, RpcErrorCode.Disconnected))
    },
  }
}
