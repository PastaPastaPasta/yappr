import { createEngineModule, type EngineRuntime } from './engine'
import { engage } from './engage'
import { explore } from './explore'
import { feed } from './feed'
import { graph } from './graph'
import { posts } from './posts'
import { profiles } from './profiles'

/**
 * The engine API. The RN host imports `type EngineApi` only and calls it
 * through `createEngineClient<EngineApi>()`; adding a method here is all it
 * takes to expose it.
 */
export function createEngineApi(runtime: EngineRuntime = {}) {
  return {
    engine: createEngineModule(runtime),
    feed,
    posts,
    engage,
    profiles,
    graph,
    explore,
  }
}

export type EngineApi = ReturnType<typeof createEngineApi>

export type { EngineInfo, EngineRuntime } from './engine'
export type * from './dto'
export type { PlatformInfoDTO } from '../dto/capabilities'
