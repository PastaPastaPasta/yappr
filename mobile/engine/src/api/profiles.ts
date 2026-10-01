import { blockService } from '@/lib/services/block-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { followService } from '@/lib/services/follow-service'
import { identityService } from '@/lib/services/identity-service'
import { loadUserStats } from '@/lib/services/social-stats-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { RpcError } from '../protocol/envelope'
import { avatarOf, viewerId } from '../dto/hydrate'
import { toProfileDTO, type ProfileDTO } from './dto'

/** Base58 of 32 bytes: 43 or 44 characters. */
const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

export const profiles = {
  /**
   * A profile by identity id or DPNS name (`alice`, `alice.dash`, `@alice`),
   * as web's /user page loads it: stats, the profile document, every name
   * and, signed in, the viewer's follow and block status. An identity
   * without a profile document is named by its DPNS label (#605). Rejects
   * when the profile read failed rather than reporting "no profile". `null`
   * when the identity does not exist, or for a name DPNS did not resolve:
   * lib's `resolveIdentity` reports an unreachable DPNS as "not found" too,
   * so a `null` for a name may be transient.
   */
  async get(identityIdOrName: string): Promise<ProfileDTO | null> {
    const input = identityIdOrName.trim().replace(/^@/, '')
    const id = IDENTITY_ID.test(input) ? input : await dpnsService.resolveIdentity(input)
    if (!id) return null
    const viewer = viewerId()
    const other = viewer && viewer !== id ? viewer : null
    const [stats, profile, usernames, follows, blocks] = await Promise.all([
      loadUserStats(id),
      unifiedProfileService.getProfile(id),
      dpnsService.getAllUsernamesSorted(id),
      other ? followService.isFollowing(id, other) : false,
      // The block status decorates the header; an unreadable block list is `null`, not a failed profile.
      other ? blockService.isBlocked(id, other).catch(() => null) : false,
    ])
    if (!profile) {
      // getProfile reports a failed read as null too: ask strictly (profileExists rejects on failure).
      if (await unifiedProfileService.profileExists(id)) throw new RpcError('The profile could not be read', 'NETWORK')
      if (usernames.length === 0 && !(await identityService.getIdentity(id))) return null
    }
    return toProfileDTO({
      id,
      profile,
      avatar: await avatarOf(id),
      usernames,
      stats,
      ...(viewer ? { viewer: { follows, blocks, isSelf: viewer === id } } : {}),
    })
  },
}
