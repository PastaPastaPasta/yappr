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
  return 'other'
}
