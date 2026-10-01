/**
 * The engine API behind the real dispatcher, client and codec, as the read
 * contract suite drives it. Each call to `connectEngine` is a fresh engine
 * over the same storage: what the host's restart looks like to the engine.
 */
import { createEngineApi, type EngineApi } from '../../../src/api'
import { createDispatcher } from '../../../src/rpc/dispatcher'
import { createEngineClient } from '../../../src/rpc/client'
import { createInProcessPair } from '../../../src/rpc/transport'

/** 0.5 DASH in credits (1 DASH = 1e11 credits): below it a pool persona needs a top-up. */
export const MIN_POOL_CREDITS = 50_000_000_000n

export function connectEngine() {
  const [hostSide, engineSide] = createInProcessPair()
  const events: { event: string; payload: unknown }[] = []
  const dispatcher = createDispatcher({
    api: createEngineApi({ emit: (event, payload) => dispatcher.emit(event, payload) }),
    transport: engineSide,
  })
  const client = createEngineClient<EngineApi>(hostSide, { timeoutMs: 300_000 })
  for (const event of ['session.changed', 'session.keyRequired', 'write.status', 'engine.notice']) {
    client.on(event, payload => events.push({ event, payload }))
  }
  dispatcher.hello({ bundleHash: 'node' })
  return { api: client.api, events }
}
