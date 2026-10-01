import { createEngineModule, type EngineRuntime } from './engine'
import { feed } from './feed'
import { posts } from './posts'
import { profiles } from './profiles'
import { createSessionModule } from './session'
import { settings } from './settings'
import { createEngineTicketStore, createWritesModule } from './writes'
import { setNoticeSink } from '../shims/toast'

/**
 * The engine API. The RN host imports `type EngineApi` only and calls it
 * through `createEngineClient<EngineApi>()`; adding a method here is all it
 * takes to expose it.
 */
export function createEngineApi(runtime: EngineRuntime = {}) {
  const emit = runtime.emit ?? (() => undefined)
  setNoticeSink(notice => emit('engine.notice', notice))
  const tickets = createEngineTicketStore(emit)
  return {
    engine: createEngineModule(runtime),
    feed,
    posts,
    profiles,
    session: createSessionModule({ emit, tickets, secureDurable: runtime.secureDurable }),
    settings,
    writes: createWritesModule(tickets),
  }
}

export type EngineApi = ReturnType<typeof createEngineApi>

export type { EngineInfo, EngineRuntime } from './engine'
export type * from './dto'
export type * from './session'
export type * from './settings'
export type * from './writes'
export type { EngineNotice } from '../shims/toast'
