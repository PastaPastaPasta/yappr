import { createEngineModule, type EngineRuntime } from './engine'
import { engage } from './engage'
import { explore } from './explore'
import { feed } from './feed'
import { graph } from './graph'
import { posts } from './posts'
import { profiles } from './profiles'
import { createDmModule } from './dm'
import { createSessionModule, type SessionEvents } from './session'
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
  const dm = createDmModule({ emit, tickets, secureDurable: runtime.secureDurable })
  return {
    engine: createEngineModule({
      ...runtime,
      // A backgrounded app is held until the DM state is saved (PRD DM-14).
      lifecycle: async state => {
        await runtime.lifecycle?.(state)
        await dm.hooks.lifecycle(state)
      },
    }),
    feed,
    posts,
    engage,
    profiles,
    session: createSessionModule({
      emit: (event, payload) => {
        emit(event, payload)
        if (event === 'session.changed') dm.hooks.sessionChanged((payload as SessionEvents['session.changed']).session?.identityId ?? null)
      },
      tickets,
      secureDurable: runtime.secureDurable,
      stopDm: dm.hooks.stop,
    }),
    dm: dm.api,
    settings,
    writes: createWritesModule(tickets),
    graph,
    explore,
  }
}

export type EngineApi = ReturnType<typeof createEngineApi>

export type { EngineInfo, EngineRuntime } from './engine'
export type * from './dto'
export type * from './dm'
export type * from './session'
export type * from './settings'
export type * from './writes'
export type { EngineNotice } from '../shims/toast'
export type { PlatformInfoDTO } from '../dto/capabilities'
