import { authorsCanBeRestricted, liveValueFor, type TargetKind } from '@/lib/contract-topology'
import { isConsensusRefusal } from '@/lib/error-utils'
import { logger } from '@/lib/logger'
import { restrictionService } from './restriction-service'

/**
 * Creates a post or reply with the `live` value its cut of the contract wants
 * (docs/SOCIAL_V18.md "Restriction"): `true` on v13 to v17, nothing before.
 * On v18 it is a lane: 1 for an author in good standing, 2 while a
 * `restriction` is in force, and the contract's `restrictedLane` rule refuses
 * the wrong one (10422) on create.
 *
 * The author's standing is read once per session. When Platform refuses the
 * create, the standing is read again: if it changed since (a moderator placed
 * or lifted a restriction mid-session) the document is rebuilt with the
 * corrected lane and sent once more. A refusal for any other reason, or one
 * the standing does not explain, is rethrown untouched.
 */
export async function createInLiveLane<T>(
  kind: TargetKind,
  ownerId: string,
  data: Record<string, unknown>,
  create: (data: Record<string, unknown>) => Promise<T>
): Promise<T> {
  const write = (restricted: boolean): Promise<T> => {
    const live = liveValueFor(kind, restricted)
    return create(live === undefined ? data : { ...data, live })
  }

  if (!authorsCanBeRestricted()) return write(false)

  // A standing that cannot be read is guessed as "not restricted"; the refusal path below corrects a wrong guess.
  const restricted = await restrictionService.isRestricted(ownerId).catch((error: unknown) => {
    logger.warn('Could not read the author\'s restriction standing; writing the listed lane', error)
    return false
  })
  try {
    return await write(restricted)
  } catch (error) {
    if (!isConsensusRefusal(error)) throw error
    const now = (await restrictionService.refresh(ownerId))?.state === 1
    if (now === restricted) throw error
    logger.warn(`The ${kind}'s lane was refused; the author's standing changed, writing it again`)
    return write(now)
  }
}
