import { RemoteError, parse, stringify } from '../protocol/codec'
import {
  PROTOCOL_VERSION,
  RpcErrorCode,
  isEnvelope,
  type EngineHello,
  type LogLevel,
} from '../protocol/envelope'
import type { Transport } from './transport'

/** `T` as seen from the host: every method returns a Promise of its awaited result. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K] extends object ? Remote<T[K]> : never
}

export interface ClientOptions {
  /** Per-call timeout; 0 disables it. Default 60 s (a feed page can chain several DAPI round trips). */
  timeoutMs?: number
  onLog?: (level: LogLevel, message: string) => void
}

export interface EngineClient<T> {
  api: Remote<T>
  /** Resolves with the engine's hello; calls made earlier are queued until then. */
  ready: Promise<EngineHello>
  on(event: string, handler: (payload: unknown) => void): () => void
  /** Reject every pending call (the engine process died) and stop listening. */
  close(reason?: string): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * The host side of the RPC. `api` is a Proxy: `client.api.feed.forYou(x)`
 * sends `{ path: 'feed.forYou', args: [x] }`, so adding an engine method
 * needs no change here. Requests wait for `engine.hello`, and a hello with a
 * different protocol version rejects everything instead of guessing.
 */
export function createEngineClient<T>(transport: Transport, options: ClientOptions = {}): EngineClient<T> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const pending = new Map<string, Pending>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let nextId = 0
  let closedReason: string | null = null

  let markReady!: (hello: EngineHello) => void
  let markFailed!: (error: Error) => void
  const ready = new Promise<EngineHello>((resolve, reject) => {
    markReady = resolve
    markFailed = reject
  })
  // A failed handshake is reported through each call; this keeps it from
  // also surfacing as an unhandled rejection when nobody awaits `ready`.
  ready.catch(() => undefined)

  const settle = (id: string, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (outcome.ok) entry.resolve(outcome.value)
    else entry.reject(outcome.error)
  }

  const unsubscribe = transport.onMessage((message) => {
    let envelope: unknown
    try {
      envelope = parse(message)
    } catch {
      return
    }
    if (!isEnvelope(envelope)) return
    switch (envelope.t) {
      case 'res':
        if (envelope.ok) settle(envelope.id, { ok: true, value: envelope.value })
        else settle(envelope.id, { ok: false, error: envelope.error instanceof Error ? envelope.error : new RemoteError(envelope.error) })
        return
      case 'evt':
        if (envelope.event === 'engine.hello') {
          const hello = envelope.payload as EngineHello
          if (hello.protocol === PROTOCOL_VERSION) markReady(hello)
          else markFailed(Object.assign(new Error(`Engine speaks protocol ${hello.protocol}, host expects ${PROTOCOL_VERSION}`), { code: RpcErrorCode.ProtocolMismatch }))
        }
        listeners.get(envelope.event)?.forEach(handler => handler(envelope.payload))
        return
      case 'log':
        options.onLog?.(envelope.level, envelope.message)
        return
    }
  })

  const disconnected = (reason: string) => Object.assign(new Error(reason), { code: RpcErrorCode.Disconnected })

  const call = async (path: string, args: unknown[]): Promise<unknown> => {
    if (closedReason !== null) throw disconnected(closedReason)
    await ready
    if (closedReason !== null) throw disconnected(closedReason)
    const id = String(++nextId)
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          settle(id, { ok: false, error: Object.assign(new Error(`Engine call ${path} timed out after ${timeoutMs} ms`), { code: RpcErrorCode.Timeout }) })
        }, timeoutMs)
      }
      pending.set(id, entry)
      try {
        transport.send(stringify({ t: 'req', v: PROTOCOL_VERSION, id, path, args }))
      } catch (error) {
        settle(id, { ok: false, error })
      }
    })
  }

  const proxyAt = (path: string[]): unknown => new Proxy(() => undefined, {
    get(_target, key) {
      // Not thenable: `await client.api` must not look like a call to `then`.
      if (typeof key !== 'string' || key === 'then') return undefined
      return proxyAt([...path, key])
    },
    apply(_target, _this, args: unknown[]) {
      return call(path.join('.'), args)
    },
  })

  return {
    api: proxyAt([]) as Remote<T>,
    ready,
    on(event, handler) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, set = new Set())
      set.add(handler)
      return () => { set.delete(handler) }
    },
    close(reason = 'Engine connection closed') {
      closedReason = reason
      unsubscribe()
      markFailed(disconnected(reason))
      for (const id of [...pending.keys()]) settle(id, { ok: false, error: disconnected(reason) })
    },
  }
}
