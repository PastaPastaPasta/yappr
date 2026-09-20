import toast from 'react-hot-toast'
import { isBarredFromContractError, moderationService } from '@/lib/services/moderation-service'

/**
 * When a write was refused because the SIGNER is banned or suspended from
 * the contract (41107/41108), say so — with the recorded reason and, for a
 * suspension, when it lapses — instead of a generic failure or an offer to
 * buy YAPP. Returns false when the error is something else, so the caller's
 * own messaging runs.
 */
export function reportBarredWrite(error: unknown, identityId: string | undefined): boolean {
  if (!identityId || !isBarredFromContractError(error)) return false
  moderationService.getStanding(identityId, { fresh: true }).then((standing) => {
    if (standing.banned) {
      toast.error(`You are banned from this contract${standing.banReason ? `: ${standing.banReason}` : '.'}`, { duration: 8000 })
    } else if (standing.suspendedUntil !== null) {
      const until = new Date(standing.suspendedUntil).toLocaleString()
      toast.error(`You are suspended until ${until}${standing.suspensionReason ? `: ${standing.suspensionReason}` : '.'}`, { duration: 8000 })
    } else {
      toast.error('This contract\'s moderators have barred your account from writing.')
    }
  }).catch(() => toast.error('This contract\'s moderators have barred your account from writing.'))
  return true
}
