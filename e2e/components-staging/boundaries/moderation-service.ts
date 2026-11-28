import { moderatedTypeOpenFor, moderationServiceFor as realServiceFor, type ModerationService } from '../../../lib/services/moderation-service'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { gate, seatedTeam } from '../mocks'
export * from '../../../lib/services/moderation-service'

// The registered social interim is `notYetUsable`: its moderated types open only once a team is seated.
async function moderatedTypeOpen(): Promise<boolean> {
  const open = moderatedTypeOpenFor('notYetUsable', seatedTeam ? { leaderId: 'leader', members: [] } : null)
  gate.answers += 1
  return open
}

export function moderationServiceFor(key: ModeratedContractKey): ModerationService {
  return Object.assign(Object.create(realServiceFor(key)), { moderatedTypeOpen })
}
export const moderationService = moderationServiceFor('social')
