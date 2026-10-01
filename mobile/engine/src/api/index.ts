import { createEngineModule, type EngineRuntime } from './engine'
import { createEngageWrites, engage } from './engage'
import { explore } from './explore'
import { feed } from './feed'
import { createGraphWrites, graph } from './graph'
import { createNotificationsModule } from './notifications'
import { createPostWrites, posts } from './posts'
import { createProfileWrites, profiles } from './profiles'
import { createSafetyModule } from './safety'
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
    posts: { ...posts, ...createPostWrites(tickets, emit) },
    engage: { ...engage, ...createEngageWrites(tickets) },
    profiles: { ...profiles, ...createProfileWrites(tickets) },
    session: createSessionModule({ emit, tickets, secureDurable: runtime.secureDurable }),
    settings,
    writes: createWritesModule(tickets),
    graph: { ...graph, ...createGraphWrites(tickets) },
    explore,
    safety: createSafetyModule(tickets),
    notifications: createNotificationsModule(emit),
  }
}

export type EngineApi = ReturnType<typeof createEngineApi>

export type { EngineInfo, EngineRuntime } from './engine'
export type * from './dto'
export type { ContentCreatedEvent, DraftDTO } from './posts'
export type { ProfilePatchDTO } from './profiles'
export type * from './safety'
export type * from './notifications'
export type * from './session'
export type * from './settings'
export type * from './writes'
export type { EngineNotice } from '../shims/toast'
export type { PlatformInfoDTO } from '../dto/capabilities'
