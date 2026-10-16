import type { EvoSDK } from '@dashevo/evo-sdk'
import { isQuorumKeyUnavailableError } from '@/lib/quorum-gap'
import { logger } from '@/lib/logger'
import { SDK_FACADES, type SdkFacade } from './sdk-facades'

/**
 * Proved reads repeated through a quorum rotation.
 *
 * For ~15–20 s around every quorum rotation the trusted quorum source lags the
 * chain, and every proof signed by the new quorum fails with wasm-sdk's
 * retryable `QuorumKeyUnavailable` (`isQuorumKeyUnavailableError`). The
 * SDK's own retries do not cover it; the same instance recovers by itself. So
 * a read that hits it is run again here, with backoff, for about half a
 * minute, and the user never sees the gap.
 *
 * Reads only. A write is never repeated: the one whose result could not be
 * verified may have landed (see `isUnverifiedOutcomeError`), and its caller
 * confirms it by reading back.
 */

export interface ReadRetryPolicy {
  /** No new attempt starts once this much time would have passed since the first. */
  budgetMs: number
  initialDelayMs: number
  maxDelayMs: number
}

/**
 * Covers the ~17 s gap seen on sakura. The last attempt starts by 20 s, which
 * leaves it room inside the mobile host's 30 s read deadline. An unreachable
 * quorum SERVICE ("quorum source unavailable") is an outage, not a gap, and is
 * not retried.
 */
export const QUORUM_GAP_RETRY: ReadRetryPolicy = { budgetMs: 20_000, initialDelayMs: 1_000, maxDelayMs: 4_000 }

export interface RetryClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: RetryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Run `attempt(0)`, and while it fails on a quorum key the SDK does not have
 * yet, `attempt(1)`, `attempt(2)`, … with backoff until the budget runs out.
 * Any other failure, or the last quorum failure, is the caller's.
 */
export async function retryThroughQuorumGap<T>(
  attempt: (n: number) => Promise<T>,
  label: string,
  policy: ReadRetryPolicy = QUORUM_GAP_RETRY,
  clock: RetryClock = realClock
): Promise<T> {
  const started = clock.now()
  let delay = policy.initialDelayMs
  for (let n = 0; ; n++) {
    try {
      return await attempt(n)
    } catch (error) {
      if (!isQuorumKeyUnavailableError(error) || clock.now() - started + delay > policy.budgetMs) throw error
      if (n === 0) logger.info(`${label}: the proof's quorum key is not available yet (quorum rotation); retrying the read`)
      await clock.sleep(delay)
      delay = Math.min(delay * 2, policy.maxDelayMs)
    }
  }
}

/** Reads that verify a proof but have no `*WithProof` sibling to recognise them by. */
const EXTRA_READS: Partial<Record<SdkFacade, readonly string[]>> = {
  dpns: ['isNameAvailable', 'resolveName'],
  moderationCharters: ['seatedCharter', 'submittedCharter', 'team', 'submittedCharters', 'joinRequests', 'pendingResignationRequests'],
}

/**
 * Whether `name` on `facade` is a read: a `*WithProof` method, a method with a
 * `*WithProof` sibling, or a listed one. Every write (create, transfer,
 * broadcast, …) has no proof sibling, so a write the SDK adds later is left
 * alone rather than repeated.
 */
export function isRetriedRead(facade: object, facadeName: SdkFacade, name: string): boolean {
  if (name.endsWith('WithProof')) return true
  if (typeof (facade as Record<string, unknown>)[`${name}WithProof`] === 'function') return true
  return EXTRA_READS[facadeName]?.includes(name) ?? false
}

type Method = (...args: unknown[]) => unknown

/** Each wrapped facade's read methods as they were before wrapping, so a retry never nests another. */
const unwrapped = new WeakMap<object, Map<string, Method>>()

/**
 * Wrap every read on `sdk`'s facades in {@link retryThroughQuorumGap}. A
 * repeat runs on the instance `resolveSdk` returns (the SDK may have been
 * rebuilt meanwhile), falling back to `sdk` when none can be had.
 *
 * Install once per constructed SDK, after the failure observer, so every
 * attempt is observed.
 */
export function installReadRetry(
  sdk: EvoSDK,
  resolveSdk: () => Promise<EvoSDK>,
  policy: ReadRetryPolicy = QUORUM_GAP_RETRY,
  clock: RetryClock = realClock
): void {
  for (const facadeName of SDK_FACADES) {
    const facade = sdk[facadeName] as unknown as Record<string, unknown> | undefined
    if (!facade || typeof facade !== 'object') continue
    const originals = new Map<string, Method>()
    for (const name of methodNames(facade)) {
      if (!isRetriedRead(facade, facadeName, name)) continue
      const original = facade[name] as Method
      originals.set(name, original)
      Object.defineProperty(facade, name, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          const first = original.apply(facade, args)
          if (!isThenable(first)) return first
          return retryThroughQuorumGap(async (n) => {
            if (n === 0) return first
            const current = await resolveSdk().catch(() => sdk)
            const target = current[facadeName] as unknown as Record<string, unknown>
            const method = unwrapped.get(target)?.get(name) ?? (target[name] as Method)
            return method.apply(target, args)
          }, `${facadeName}.${name}`, policy, clock)
        },
      })
    }
    unwrapped.set(facade, originals)
  }
}

function methodNames(facade: object): string[] {
  const prototype = Object.getPrototypeOf(facade) as object | null
  const names = new Set([...(prototype ? Object.getOwnPropertyNames(prototype) : []), ...Object.getOwnPropertyNames(facade)])
  names.delete('constructor')
  return [...names].filter((name) => typeof (facade as Record<string, unknown>)[name] === 'function')
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}
