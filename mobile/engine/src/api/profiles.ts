import { dpnsService } from '@/lib/services/dpns-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { loadUserStats } from '@/lib/services/social-stats-service'
import { toProfileDTO, type ProfileDTO } from './dto'

/** Base58 of 32 bytes: 43 or 44 characters. */
const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

export const profiles = {
  /**
   * A profile by identity id or DPNS name (`alice`, `alice.dash`, `@alice`).
   * `null` when the name does not resolve. An identity without a profile
   * document still returns a profile named by its DPNS label, as on web's
   * /user page, which this mirrors (stats, profile document, names).
   */
  async get(identityIdOrName: string): Promise<ProfileDTO | null> {
    const input = identityIdOrName.trim().replace(/^@/, '')
    const id = IDENTITY_ID.test(input) ? input : await dpnsService.resolveIdentity(input)
    if (!id) return null
    const [stats, profile, usernames] = await Promise.all([
      loadUserStats(id),
      unifiedProfileService.getProfile(id),
      dpnsService.getAllUsernamesSorted(id),
    ])
    return toProfileDTO({
      id,
      profile,
      usernames,
      stats,
      defaultAvatarUrl: unifiedProfileService.getDefaultAvatarUrl(id),
    })
  },
}
