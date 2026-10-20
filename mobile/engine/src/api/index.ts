import { createEngineModule, type EngineRuntime } from './engine'
import { createEngageWrites, engage } from './engage'
import { explore } from './explore'
import { feed } from './feed'
import { createDmModule } from './dm'
import { createDpnsModule } from './dpns'
import { createGraphWrites, graph } from './graph'
import { createNotificationsModule } from './notifications'
import { createPollWrites, createPostWrites, posts } from './posts'
import { createPrivateFeedWrites, privateFeedReads } from './private-feed'
import { createProfileWrites, profiles } from './profiles'
import { createSafetyModule } from './safety'
import { createMobileAuthController, createSessionModule, foregroundBalanceRefresh, type SessionEvents } from './session'
import { settings } from './settings'
import { createEngineTicketStore, createWritesModule } from './writes'
import { setNoticeSink } from '../shims/toast'
import { blogReads, createBlogWrites } from './blog'

/**
 * The engine API. The RN host imports `type EngineApi` only and calls it
 * through `createEngineClient<EngineApi>()`; adding a method here is all it
 * takes to expose it.
 */
export function createEngineApi(runtime: EngineRuntime = {}) {
  const emit = runtime.emit ?? (() => undefined)
  setNoticeSink(notice => emit('engine.notice', notice))
  const tickets = createEngineTicketStore(emit)
  /** Shared by the session module, its controller and messages (`SessionModuleOptions.unhydrated`). */
  const unhydrated = new Set<string>()
  const dm = createDmModule({ emit, tickets, secureDurable: runtime.secureDurable, unhydrated })
  // Session changes reach notifications and direct messages too: what they hold belongs to one account.
  const notifications = createNotificationsModule(emit)
  const controller = createMobileAuthController({ unhydrated })
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
    // A read whose proof names a quorum the SDK has no key for yet is retried inside lib's SDK wrapper
    // (lib/services/sdk-read-retry.ts); writes never are.
    feed,
    posts: { ...posts, ...createPostWrites(tickets, emit), ...createPollWrites(tickets) },
    engage: { ...engage, ...createEngageWrites(tickets) },
    profiles: { ...profiles, ...createProfileWrites(tickets) },
    session: createSessionModule({
      emit: sessionEmit,
      controller,
      unhydrated,
      tickets,
      secureDurable: runtime.secureDurable,
      holdSecure: runtime.holdSecure,
      stopDm: dm.hooks.stop,
      resumeDm: dm.hooks.resume,
      forgetDm: dm.hooks.forget,
    }),
    dm: dm.api,
    settings,
    writes: createWritesModule(tickets),
    graph: { ...graph, ...createGraphWrites(tickets) },
    explore,
    safety: createSafetyModule(tickets),
    notifications: notifications.api,
    privateFeed: { ...privateFeedReads, ...createPrivateFeedWrites(tickets) },
    dpns: createDpnsModule(tickets, controller),
    blogs: { ...blogReads, ...createBlogWrites(tickets) },
  }
}

export type EngineApi = ReturnType<typeof createEngineApi>

export type { EngineDiagnostics, EngineInfo, EngineRuntime } from './engine'
export type { DapiEndpointDTO, DapiStatusDTO } from '../dapi-monitor'
export type * from './dto'
export type * from './dm'
export type { ContentCreatedEvent, DraftDTO } from './posts'
export type { DpnsRegistrationDTO } from './dpns'
export type { ProfilePatchDTO } from './profiles'
export type * from './private-feed'
export type * from './safety'
export type * from './notifications'
export type * from './session'
export type * from './settings'
export type * from './writes'
export type { EngineNotice } from '../shims/toast'
export type { PlatformInfoDTO } from '../dto/capabilities'
export type * from './blog'
