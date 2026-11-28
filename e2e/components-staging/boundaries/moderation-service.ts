import { moderationServiceFor as realServiceFor, type ModerationService } from '../../../lib/services/moderation-service'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { seatedTeam } from '../mocks'
export * from '../../../lib/services/moderation-service'

// The registered social interim is `notYetUsable`: its moderated types open only once a team is seated.
export function moderationServiceFor(key: ModeratedContractKey): ModerationService {
  return Object.assign(Object.create(realServiceFor(key)), { moderatedTypeOpen: async () => seatedTeam })
}
export const moderationService = moderationServiceFor('social')
