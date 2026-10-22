/**
 * What a hide's `modLabel` or a restriction's `reason` (1–63) says, as text.
 *
 * Yappr writes the chosen reason's place (1-based) in the seated team's
 * charter (lib/moderation-labels.ts); this reads each contract's seated
 * charter reasons once per session and resolves labels against them. While no
 * team is seated the label is an interim report class instead. Anything that
 * cannot be resolved (the charter could not be read, or does not list the
 * label) is null: callers then say "Hidden by moderators" with no reason,
 * never a bare number.
 *
 * Shared by the web app's labels, report queue and moderation log, and by the
 * mobile engine.
 */
import { logger } from '@/lib/logger'
import { labelText, type CharterReasonLike } from '@/lib/moderation-labels'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderationElectionService } from './moderation-election-service'

/** A contract's seated charter reasons, or null while no team is seated. */
type CharterRead = readonly CharterReasonLike[] | null

const reads = new Map<ModeratedContractKey, Promise<CharterRead>>()
const settled = new Map<ModeratedContractKey, CharterRead>()

/**
 * The seated team's charter reasons on `contract` (null while none is
 * seated, and off an elected contract), read once per session. A failed read
 * is not kept, so the next call asks again. Rejects when the read fails.
 */
export function charterReasonsFor(contract: ModeratedContractKey): Promise<CharterRead> {
  const cached = reads.get(contract)
  if (cached) return cached
  const declared = moderatedContract(contract)
  const read: Promise<CharterRead> = declared.elected() === null
    ? Promise.resolve(null)
    : moderationElectionService.getSeatedTeamAndReasons(declared.contractId).then(({ seated, reasons }) => (seated ? reasons : null))
  reads.set(contract, read)
  read.then((reasons) => { settled.set(contract, reasons) }).catch(() => {
    if (reads.get(contract) === read) reads.delete(contract)
  })
  return read
}

/** The text of `label` on `contract`, or null when it cannot be resolved. Never rejects. */
export async function charterReasonText(contract: ModeratedContractKey, label: number | undefined): Promise<string | null> {
  if (typeof label !== 'number') return null
  try {
    return labelText(label, await charterReasonsFor(contract))
  } catch (error) {
    logger.warn(`charterReasonText(${contract}): could not read the seated charter`, error)
    return null
  }
}

/**
 * The text of `label` from what this session already read, without reading:
 * undefined while the charter has not been read yet, null when it was and the
 * label resolves to nothing.
 */
export function peekCharterReasonText(contract: ModeratedContractKey, label: number | undefined): string | null | undefined {
  if (typeof label !== 'number') return null
  if (!settled.has(contract)) return undefined
  return labelText(label, settled.get(contract) ?? null)
}

/** Forget what was read (a team was seated or re-elected, or a test). */
export function forgetCharterReasons(contract?: ModeratedContractKey): void {
  if (contract) {
    reads.delete(contract)
    settled.delete(contract)
  } else {
    reads.clear()
    settled.clear()
  }
}
