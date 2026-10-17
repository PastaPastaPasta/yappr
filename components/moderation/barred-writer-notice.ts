import toast from 'react-hot-toast'
import { isBarredFromContractError, moderationClosedCopy } from '@/lib/error-utils'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderationServiceFor } from '@/lib/services/moderation-service'

/** Where a ban or suspension applies, as the user reads it. */
const BARRED_FROM: Record<ModeratedContractKey, string> = {
  social: 'this contract',
  storefront: 'Yappr stores',
  blog: 'Yappr blogs',
}

/**
 * When a write was refused because the SIGNER is banned or suspended from
 * the contract (41107/41108), say so — with the recorded reason and, for a
 * suspension, when it lapses — instead of a generic failure or an offer to
 * buy YAPP. Each contract keeps its own lists, so `contract` (social by
 * default) names the one the write went to. Returns false when the error is
 * something else, so the caller's own messaging runs.
 */
export function reportBarredWrite(error: unknown, identityId: string | undefined, contract: ModeratedContractKey = 'social'): boolean {
  if (!identityId || !isBarredFromContractError(error)) return false
  const where = BARRED_FROM[contract]
  // What to say when the standing read cannot name the list or its reason: the
  // refusal itself already proved the account is barred.
  const barred = () => toast.error(contract === 'social'
    ? 'This contract\'s moderators have barred your account from writing.'
    : `Moderators have barred your account from ${where}.`)
  moderationServiceFor(contract).getStanding(identityId, { fresh: true }).then((standing) => {
    if (standing.banned) {
      toast.error(`You are banned from ${where}${standing.banReason ? `: ${standing.banReason}` : '.'}`, { duration: 8000 })
    } else if (standing.suspendedUntil !== null) {
      const until = new Date(standing.suspendedUntil).toLocaleString()
      toast.error(`You are suspended${contract === 'social' ? '' : ` from ${where}`} until ${until}${standing.suspensionReason ? `: ${standing.suspensionReason}` : '.'}`, { duration: 8000 })
    } else {
      barred()
    }
  }).catch(barred)
  return true
}

/**
 * The moderation refusals a storefront or blog write can meet, said in the
 * product's words: closed until its first moderators are elected (41200), or
 * the writer banned or suspended there (41107/41108). Toasts and returns true
 * when it handled the error; false leaves the caller's own message.
 */
export function reportModerationRefusal(error: unknown, identityId: string | undefined, contract: Exclude<ModeratedContractKey, 'social'>): boolean {
  const closed = moderationClosedCopy(error, contract)
  if (closed) {
    toast.error(closed, { duration: 8000 })
    return true
  }
  return reportBarredWrite(error, identityId, contract)
}
