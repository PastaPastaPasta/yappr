/**
 * Group grant acceptance (docs/DM_V5.md §6.2).
 *
 * A `0x05` grant is accepted only if it came on the counterpart's 1:1 stream
 * and the roster that counterpart owns under `roster(gid)` decrypts with the
 * granted key (or one derived from it by ratchet or a newer keyring) and
 * lists the member. So only the real owner can add you, and a forwarded key
 * adds you to nothing.
 */

import { bytesEqual } from '@/lib/bytes'
import { epochBefore } from './keys'
import type { GroupGrant, IdentityId, OpenedRoster } from './types'

export interface GrantCheck {
  grant: GroupGrant
  /** The counterpart of the 1:1 stream the grant arrived on (its `$ownerId` was already checked against it). */
  streamSender: IdentityId
  /** `$ownerId` of the `dmGroupDoc` fetched at `roster(grant.gid)`. */
  rosterOwner: IdentityId
  /** That roster opened from the granted key (`openRoster`), or null if it did not decrypt. */
  roster: OpenedRoster | null
  /** The member receiving the grant: me. */
  memberId: IdentityId
}

export type GrantVerdict =
  | { accepted: true }
  | { accepted: false; reason: 'own-stream' | 'wrong-owner' | 'roster-unreadable' | 'stale-roster' | 'ended' | 'not-a-member' }

/**
 * Decide whether to accept a grant. The caller fetches the roster under
 * `$ownerId == streamSender` and opens it with `openRoster` from the granted
 * key (after applying any newer keyrings it unwraps); this checks the rest.
 *
 * `roster-unreadable` can be transient: the owner replaces the roster before
 * sending the grant (§6.4), but the node a member reads from can lag behind
 * and still serve the old roster. Keep such a grant and re-check it on later
 * polls.
 */
export function checkGrant(check: GrantCheck): GrantVerdict {
  if (bytesEqual(check.streamSender, check.memberId)) return { accepted: false, reason: 'own-stream' }
  if (!bytesEqual(check.rosterOwner, check.streamSender)) return { accepted: false, reason: 'wrong-owner' }
  if (!check.roster) return { accepted: false, reason: 'roster-unreadable' }
  const { content } = check.roster
  if (epochBefore(content, check.grant)) return { accepted: false, reason: 'stale-roster' }
  if (content.ended) return { accepted: false, reason: 'ended' }
  if (!content.members.some((id) => bytesEqual(id, check.memberId))) return { accepted: false, reason: 'not-a-member' }
  return { accepted: true }
}
