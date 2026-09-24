import type { WriteFailure } from './types'

/**
 * Classify a refused DM v5 write from its error text
 * (docs/evidence/dm-v5-battery.json): 40105 is a unique-index collision
 * ("has duplicate unique properties"), 40106 a replace on an old revision
 * ("has invalid revision"). Both also arrive with their numeric code; the
 * prose is matched too because several refusals surface with code -1. A
 * nonce refusal ("nonce already present at tip") is `nonce`: retry as is.
 */
export function classifyWriteFailure(message: string): WriteFailure {
  if (/duplicate unique properties|\bcode"?\s*[=:]\s*40105\b/i.test(message)) return 'duplicate'
  if (/invalid revision|\bcode"?\s*[=:]\s*40106\b/i.test(message)) return 'stale'
  // Two devices of one identity picked the same identity-contract nonce; nothing was written, and a
  // fresh nonce (re-read on the next attempt) goes through.
  if (/invalid identity nonce|nonce already present/i.test(message)) return 'nonce'
  // Never reached a verdict: the connection, the node pool or the quorum cache failed.
  if (/transport|no available addresses|quorum not found in cache|invalid quorum|connection|unavailable|fetch failed|failed to fetch|load failed|network ?error|missing response message|deadline exceeded|econnreset|econnrefused|etimedout|socket hang up|\b50[234]\b/i.test(message)) return 'transport'
  return 'other'
}

/** Retries of one write after a nonce refusal (two devices of this identity writing at once). */
export const MAX_NONCE_RETRIES = 3
const NONCE_BACKOFF_BASE_MS = 250

/**
 * The wait before nonce retry `n` (0-based): `250 ms · 2^n` plus up to that
 * much jitter, so two devices that clashed do not clash again in lockstep and
 * a node that is behind on the nonce has time to catch up.
 */
export function nonceBackoffMs(n: number, random: () => number = Math.random): number {
  const base = NONCE_BACKOFF_BASE_MS * 2 ** n
  return base + Math.floor(random() * base)
}

export type Sleep = (ms: number) => Promise<void>
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `write` and, while it is refused for a nonce clash (nothing was
 * written), run it again after a backoff, up to `MAX_NONCE_RETRIES` times.
 * Every other outcome is returned as is. Each attempt rebuilds its transition,
 * so it signs with a freshly read nonce.
 */
export async function withNonceRetry<T extends { ok: true } | { ok: false; failure: WriteFailure }>(
  write: () => Promise<T>,
  sleep: Sleep = realSleep
): Promise<T> {
  let outcome = await write()
  for (let n = 0; n < MAX_NONCE_RETRIES && !outcome.ok && outcome.failure === 'nonce'; n++) {
    await sleep(nonceBackoffMs(n))
    outcome = await write()
  }
  return outcome
}
