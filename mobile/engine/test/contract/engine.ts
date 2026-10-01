/**
 * The engine API behind the real dispatcher, client and codec (an in-process
 * pair stands in for the bridge). Each call to `connectEngine` is a fresh
 * engine over the same storage: what the host's restart looks like to it.
 */
import { createEngineApi, type EngineApi } from '../../src/api'
import { createDispatcher } from '../../src/rpc/dispatcher'
import { createEngineClient } from '../../src/rpc/client'
import { createInProcessPair } from '../../src/rpc/transport'

export function connectEngine({ timeoutMs = 120_000 }: { timeoutMs?: number } = {}) {
  const [hostSide, engineSide] = createInProcessPair()
  const events: { event: string; payload: unknown }[] = []
  const dispatcher = createDispatcher({
    api: createEngineApi({ emit: (event, payload) => dispatcher.emit(event, payload) }),
    transport: engineSide,
  })
  const client = createEngineClient<EngineApi>(hostSide, { timeoutMs })
  for (const event of ['session.changed', 'session.keyRequired', 'write.status', 'engine.notice', 'content.created', 'notifications.count', 'dm.changed', 'dm.message']) {
    client.on(event, payload => events.push({ event, payload }))
  }
  dispatcher.hello({ bundleHash: 'node' })
  return { api: client.api, events }
}
