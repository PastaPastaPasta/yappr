import { createEngineModule, type EngineRuntime } from './engine'
import { createEngageWrites, engage } from './engage'
import { explore } from './explore'
import { feed } from './feed'
import { createDmModule } from './dm'
import { createGraphWrites, graph } from './graph'
import { createNotificationsModule } from './notifications'
import { createPostWrites, posts } from './posts'
import { createProfileWrites, profiles } from './profiles'
import { createSafetyModule } from './safety'
import { createMobileAuthController, createSessionModule, foregroundBalanceRefresh, type SessionEvents } from './session'
import { settings } from './settings'
import { retryReadsOnStaleQuorum } from './stale-quorum'
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
  // Session changes reach notifications and direct messages too: what they hold belongs to one account.
  const notifications = createNotificationsModule(emit)
  const controller = createMobileAuthController()
  const balance = foregroundBalanceRefresh(controller)
  const sessionEmit: typeof emit = (event, payload) => {
    if (event === 'session.changed') {
      const change = payload as SessionEvents['session.changed']
      notifications.sessionChanged(change)
      dm.hooks.sessionChanged(change)
    }
    emit(event, payload)
  }
  return {
    engine: createEngineModule({
      ...runtime,
      // A backgrounded app is held until the DM state is saved (PRD DM-14).
      lifecycle: async state => {
        await runtime.lifecycle?.(state)
        balance.lifecycle(state)
        await dm.hooks.lifecycle(state)
      },
    }),
    // The read halves only: a stale quorum cache costs a read one retry, never a write (stale-quorum.ts).
    feed: retryReadsOnStaleQuorum(feed),
    posts: { ...retryReadsOnStaleQuorum(posts), ...createPostWrites(tickets, emit) },
    engage: { ...retryReadsOnStaleQuorum(engage), ...createEngageWrites(tickets) },
    profiles: { ...retryReadsOnStaleQuorum(profiles), ...createProfileWrites(tickets) },
    session: createSessionModule({
      emit: sessionEmit,
      controller,
      tickets,
      secureDurable: runtime.secureDurable,
      stopDm: dm.hooks.stop,
      resumeDm: dm.hooks.resume,
      forgetDm: dm.hooks.forget,
    }),
    dm: dm.api,
    settings,
    writes: createWritesModule(tickets),
    graph: { ...retryReadsOnStaleQuorum(graph), ...createGraphWrites(tickets) },
    explore: retryReadsOnStaleQuorum(explore),
    safety: createSafetyModule(tickets),
    notifications: retryReadsOnStaleQuorum(notifications.api),
  }
}

export type EngineApi = ReturnType<typeof createEngineApi>

export type { EngineInfo, EngineRuntime } from './engine'
export type * from './dto'
export type * from './dm'
export type { ContentCreatedEvent, DraftDTO } from './posts'
export type { ProfilePatchDTO } from './profiles'
export type * from './safety'
export type * from './notifications'
export type * from './session'
export type * from './settings'
export type * from './writes'
export type { EngineNotice } from '../shims/toast'
export type { PlatformInfoDTO } from '../dto/capabilities'
