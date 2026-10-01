import { TtlMap } from '@/lib/caches/ttl-map'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { contractTakesReports } from '@/lib/contract-topology'
import { reportInputProblem, type ReportStatus } from '@/lib/reports'
import { blockService } from '@/lib/services/block-service'
import { reportService } from '@/lib/services/report-service'
import { RpcError } from '../protocol/envelope'
import { assertAtMost, badRequest, loadUserSummaries, notSupported, requireViewer } from '../dto/hydrate'
import { pageOfList } from '../dto/paging'
import { assertId, assertTarget, characters, relationProbe, signer, ticketIdentity, ticketTarget } from '../writes/handler-kit'
import { createdDocument, fromTransitionResult } from '../writes/lib-results'
import type { TicketStore } from '../writes/tickets'
import type { TargetRef, WriteTicket } from '../writes/types'
import type { Page, UserSummaryDTO } from './dto'

/** `block.message` (`blockService.blockUser` keeps the first 280). */
const BLOCK_MESSAGE_MAX = 280
/** `components/settings/blocked-users.tsx` reads the list whole (up to 100); the engine pages it. */
const BLOCKED_PAGE = 30

/** `use-block.ts`: an unblock that leaves the user blocked by a followed block list. */
const STILL_BLOCKED_BY_LIST = 'A block list you follow still blocks this user. Manage block lists in Settings.'

export interface BlockedUserDTO extends UserSummaryDTO {
  /** The public reason the viewer gave when blocking, if any. */
  message: string | null
}

/** The viewer's own report on a target (`reportService.getOwnReport`). */
export interface OwnReportDTO {
  id: string
  reason: number
  note: string | null
  createdAt: Date
  /** v10: how the moderators resolved it; `null` while open (and always on v9). */
  status: ReportStatus | null
  resolution: string | null
  moderatedAt: Date | null
}

interface BlockArgs {
  targetId: string
  message?: string
}

interface ReportArgs {
  target: TargetRef
  reason: number
  note?: string
}

const blockLists = new TtlMap<string, { blockedId: string; message?: string }[]>(60_000)

/**
 * Blocks and reports (`hooks/use-block.ts`, `components/settings/blocked-users.tsx`,
 * `components/moderation/report-post-modal.tsx`). The NSFW and media gates
 * run in RN; following other users' block lists is post-1.0.
 */
export function createSafetyModule(tickets: TicketStore) {
  /** The viewer's own block on the ticket's account; `getBlockProvenance` rejects when that list cannot be read. */
  const ownBlock = (expected: boolean) => relationProbe<BlockArgs>(async ({ viewer, ticket }) =>
    (await blockService.getBlockProvenance(ticketIdentity(ticket), viewer)).isOwnBlock, expected)

  tickets.register<BlockArgs>('block', {
    persistArgs: true,
    async run({ targetId, message }, ctx) {
      const result = await blockService.blockUser(signer(ctx), targetId, message)
      return fromTransitionResult(result, createdDocument(result, YAPPR_CONTRACT_ID, 'block'))
    },
    probe: ownBlock(true),
  })
  tickets.register<BlockArgs>('unblock', {
    persistArgs: true,
    async run({ targetId }, ctx) {
      const viewer = signer(ctx)
      const result = await blockService.unblockUser(viewer, targetId)
      if (!result.success) return fromTransitionResult(result)
      // Only the viewer's own block can be deleted: a followed block list keeps blocking (use-block.ts).
      const after = await blockService.getBlockProvenance(targetId, viewer).catch(() => null)
      if (after?.isBlocked) return { state: 'failed', error: new RpcError(STILL_BLOCKED_BY_LIST, 'STILL_BLOCKED') }
      return fromTransitionResult(result)
    },
    probe: ownBlock(false),
  })
  tickets.register<ReportArgs>('report', {
    persistArgs: true,
    async run({ target, reason, note }, ctx) {
      const result = await reportService.fileReport(signer(ctx), {
        kind: target.kind, targetId: target.id, targetOwnerId: target.ownerId, reason, note,
      })
      return fromTransitionResult(result, createdDocument(result, YAPPR_CONTRACT_ID, 'report'))
    },
    // getOwnReport throws on a failed read, so a missing report is a proved absence.
    probe: relationProbe(async ({ viewer, ticket }) => {
      const target = ticketTarget(ticket)
      return (await reportService.getOwnReport(viewer, target.kind, target.id)) !== null
    }, true),
  })

  function submitBlock(op: 'block' | 'unblock', targetId: string, message?: string): WriteTicket {
    assertId(targetId, 'targetId')
    if (requireViewer(op === 'block' ? 'Blocking' : 'Unblocking') === targetId) throw badRequest('You cannot block yourself')
    if (message !== undefined && typeof message !== 'string') throw badRequest('message must be a string')
    const trimmed = message?.trim()
    if (trimmed && characters(trimmed) > BLOCK_MESSAGE_MAX) throw badRequest(`Keep the message to ${BLOCK_MESSAGE_MAX} characters`)
    return tickets.submit<BlockArgs>({ op, args: { targetId, ...(trimmed ? { message: trimmed } : {}) }, target: { identityId: targetId } })
  }

  return {
    /** Block an account, with an optional public message (at most 280 characters). */
    block: async (targetId: string, options: { message?: string } = {}): Promise<WriteTicket> => submitBlock('block', targetId, options.message),

    /**
     * Delete the viewer's own block. Fails with `STILL_BLOCKED` when a block
     * list the viewer follows (set up on web) still blocks the account, as web does.
     */
    unblock: async (targetId: string): Promise<WriteTicket> => submitBlock('unblock', targetId),

    /**
     * The accounts the viewer blocked (lib reads up to 100, as the web
     * settings page), 30 a page, each with the message given. lib reports a
     * failed read as an empty list.
     */
    async blocked(cursor?: string | null): Promise<Page<BlockedUserDTO>> {
      const viewer = requireViewer('The blocked list')
      return pageOfList({
        kind: 'blocked',
        key: viewer,
        cursor,
        size: BLOCKED_PAGE,
        cache: blockLists,
        load: async () => (await blockService.getUserBlocks(viewer)).filter(block => block.blockedId),
        hydrate: async (slice) => {
          const users = await loadUserSummaries(slice.map(block => block.blockedId))
          return slice.flatMap(block => {
            const user = users.get(block.blockedId)
            return user ? [{ ...user, message: block.message || null }] : []
          })
        },
      })
    },

    /** Whether the viewer blocks each of up to 100 accounts (own blocks and followed lists; `checkBlockedBatch`). */
    async isBlocked(ids: string[]): Promise<Record<string, boolean>> {
      assertAtMost(ids, 100, 'ids')
      const blocked = await blockService.checkBlockedBatch(requireViewer('Block status'), ids)
      return Object.fromEntries(ids.map(id => [id, blocked.get(id) === true]))
    },

    /**
     * Report a post or reply to the contract's moderators. `reason` is a code
     * from `lib/reports.ts` `REPORT_REASONS` (0–8); "something else" (8)
     * needs a note, and a note is at most 500 characters. One report per
     * reporter and target: a second fails `DUPLICATE`, so read `ownReport`
     * first, as web's dialog does. Gated by `capabilities.reports`.
     */
    async report(target: TargetRef, reason: number, note?: string): Promise<WriteTicket> {
      assertTarget(target)
      const viewer = requireViewer('Reporting')
      if (!contractTakesReports()) throw notSupported('Reporting')
      if (note !== undefined && typeof note !== 'string') throw badRequest('note must be a string')
      const problem = reportInputProblem(Number.isInteger(reason) ? reason : null, note ?? '')
      if (problem) throw badRequest(problem)
      // Consensus refuses a report naming the reporter as the target's author (10419).
      if (target.ownerId === viewer) throw badRequest('You cannot report your own post')
      const trimmed = note?.trim()
      return tickets.submit<ReportArgs>({ op: 'report', args: { target, reason, ...(trimmed ? { note: trimmed } : {}) }, target })
    },

    /** The viewer's own report on a target, or `null`. Rejects when it cannot be read, so the UI never offers a second (paid) report. */
    async ownReport(target: TargetRef): Promise<OwnReportDTO | null> {
      assertTarget(target)
      const viewer = requireViewer('Your report')
      if (!contractTakesReports()) return null
      const report = await reportService.getOwnReport(viewer, target.kind, target.id)
      if (!report) return null
      return {
        id: report.id,
        reason: report.reason,
        note: report.note,
        createdAt: new Date(report.createdAt),
        status: report.status,
        resolution: report.resolution,
        moderatedAt: report.moderatedAt === null ? null : new Date(report.moderatedAt),
      }
    },
  }
}
