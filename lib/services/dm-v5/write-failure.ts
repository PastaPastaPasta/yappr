import type { WriteFailure } from './types'

/**
 * Classify a refused DM v5 write from its error text
 * (docs/evidence/dm-v5-battery.json): 40105 is a unique-index collision
 * ("has duplicate unique properties"), 40106 a replace on an old revision
 * ("has invalid revision"). Both also arrive with their numeric code; the
 * prose is matched too because several refusals surface with code -1.
 */
export function classifyWriteFailure(message: string): WriteFailure {
  if (/duplicate unique properties|\bcode"?\s*[=:]\s*40105\b/i.test(message)) return 'duplicate'
  if (/invalid revision|\bcode"?\s*[=:]\s*40106\b/i.test(message)) return 'stale'
  return 'other'
}
