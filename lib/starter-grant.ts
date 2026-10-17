import { starterGrantAmount, yappIsLocked } from '@/lib/contract-topology'
import { readScoped, writeScoped } from '@/lib/storage-scope'

/**
 * Identities whose once-per-identity starter grant is known to be claimed,
 * remembered in this browser so chain is not asked again. Only a positive
 * answer is kept: whether an identity has NOT claimed is always read from
 * chain (starterClaimFromHistory), since it may have claimed on another
 * device. The key predates this module (the e2e fixtures pre-seed it), so it
 * must not change.
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

/** True once this browser has seen `identityId`'s grant claimed (on chain, by it, or by a 40722 refusal). */
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
 * Whether an identity has claimed its starter grant: `unknown` until chain
 * has answered, and whenever it could not. Claim is only ever offered on
 * `unclaimed`, so a failed read never costs the user a refused claim.
 */
export type StarterClaimState = 'claimed' | 'unclaimed' | 'unknown'

/** The token-history `claim` document's distributionType for a once-per-identity release. */
const ONCE_PER_IDENTITY_DISTRIBUTION = 2

/**
 * The claim state from one page of the identity's token-history `claim`
 * documents for YAPP (byRecipient, oldest first). Platform writes one for
 * every claim, so a once-per-identity one means the grant is taken. A full
 * page without one proves nothing about the rest, so it reads as unknown.
 */
export function starterClaimFromHistory(
  claims: ReadonlyArray<{ distributionType?: unknown }>,
  pageLimit: number,
): StarterClaimState {
  if (claims.some((claim) => Number(claim.distributionType) === ONCE_PER_IDENTITY_DISTRIBUTION)) return 'claimed'
  return claims.length < pageLimit ? 'unclaimed' : 'unknown'
}

/**
 * How `identityId` can get more YAPP on the configured contract: `buy` it
 * (v2, v9), `claim` the one-time starter grant (v10 onwards, while chain says
 * it is unclaimed), or nothing at all (claimed, or not known yet: YAPP has no
 * purchase price, and Yappr never sends it, so it can be neither bought nor
 * received).
 */
export function yappTopUp(claimState: StarterClaimState): 'buy' | 'claim' | null {
  if (!yappIsLocked()) return 'buy'
  return starterGrantAmount() !== null && claimState === 'unclaimed' ? 'claim' : null
}
