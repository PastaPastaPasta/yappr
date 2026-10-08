import { starterGrantAmount, yappIsLocked } from '@/lib/contract-topology'
import { readScoped, writeScoped } from '@/lib/storage-scope'

/**
 * Identities whose once-per-identity starter grant is known to be claimed,
 * remembered in this browser so the prompt never returns. The key predates
 * this module (the e2e fixtures pre-seed it), so it must not change.
 */
const SETTLED_KEY = 'yappr_starter_grant_settled'

function settledIdentities(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readScoped(SETTLED_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** True once this browser has seen `identityId`'s grant claimed (by it or by a 40722 refusal). */
export function isStarterGrantSettled(identityId: string): boolean {
  return settledIdentities().has(identityId)
}

/** Remember that `identityId` has claimed its grant, so nothing offers it again. */
export function markStarterGrantSettled(identityId: string): void {
  const settled = settledIdentities()
  if (settled.has(identityId)) return
  writeScoped(SETTLED_KEY, JSON.stringify([...settled, identityId]))
}

/**
 * How `identityId` can get more YAPP on the configured contract: `buy` it
 * (v2, v9), `claim` the one-time starter grant (v10 onwards, until claimed),
 * or nothing at all (once the grant is claimed: YAPP has no purchase price,
 * and Yappr never sends it, so it can be neither bought nor received).
 */
export function yappTopUp(identityId: string): 'buy' | 'claim' | null {
  if (!yappIsLocked()) return 'buy'
  return starterGrantAmount() !== null && !isStarterGrantSettled(identityId) ? 'claim' : null
}
