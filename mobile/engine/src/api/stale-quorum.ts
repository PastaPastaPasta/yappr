import { extractErrorMessage } from '@/lib/error-utils'
import { logger } from '@/lib/logger'
import { evoSdkService } from '@/lib/services/evo-sdk-service'

/**
 * wasm-sdk 5.0.0-beta.1's trusted context fetches the quorum keys once, when
 * the SDK is built, and never refreshes them for a read. Sakura forms a quorum
 * every 24 blocks (about 4 minutes) and Platform signs with it straight away,
 * so a read whose proof names a quorum newer than the SDK fails with "invalid
 * quorum: Quorum not found in cache for hash: …". lib's failure observer
 * answers that by rebuilding the SDK, which fetches the quorum lists again,
 * but the read that hit it has already failed. Remove this once evo-sdk
 * refreshes on a miss itself (dashpay/platform#5236).
 */
export function isStaleQuorumError(error: unknown): boolean {
  return /quorum not found in cache/i.test(extractErrorMessage(error))
}

/**
 * `module` with each method run once more after a stale-quorum failure, on
 * the SDK that lib rebuilds for it. `getSdk()` waits for that rebuild, which
 * the failure observer started before the error reached this point. If no
 * SDK can be rebuilt, the caller gets the original error.
 *
 * Reads only: a failed write may already have been broadcast, so writes are
 * never repeated here (ENGINE.md §7.3).
 */
export function retryReadsOnStaleQuorum<T extends object>(module: T): T {
  return Object.fromEntries(Object.entries(module).map(([name, value]) => {
    if (typeof value !== 'function') return [name, value]
    const method = value as (...args: unknown[]) => unknown
    const retrying = async (...args: unknown[]) => {
      try {
        return await method.apply(module, args)
      } catch (error) {
        if (!isStaleQuorumError(error)) throw error
        logger.info(`Engine: ${name} hit a stale quorum cache; retrying once on the rebuilt SDK`)
        await evoSdkService.getSdk().catch(() => { throw error })
        return method.apply(module, args)
      }
    }
    return [name, retrying]
  })) as T
}
