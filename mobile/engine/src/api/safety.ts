import { TtlMap } from '@/lib/caches/ttl-map'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { blocksContractId, contractTakesReports, electedModeration } from '@/lib/contract-topology'
import { isReportGoneError, reportInputProblem, withdrawFailureMessage, type ReportStatus } from '@/lib/reports'
import { blockService } from '@/lib/services/block-service'
import { moderationElectionService } from '@/lib/services/moderation-election-service'
import { reportService } from '@/lib/services/report-service'
import { RpcError } from '../protocol/envelope'
import { assertAtMost, badRequest, loadUserSummaries, notSupported, readFailure, requireViewer } from '../dto/hydrate'
import { pageOfList } from '../dto/paging'
import { assertId, assertTarget, characters, relationProbe, signer, socialDoc, ticketIdentity, ticketTarget } from '../writes/handler-kit'
import { createdDocument, fromTransitionResult } from '../writes/lib-results'
import { ownBlockExists } from '../writes/strict-reads'
import type { TicketStore } from '../writes/tickets'
import type { TargetRef, WriteTicket } from '../writes/types'
import type { BlockSourceDTO, Page, UserSummaryDTO } from './dto'

/** `block.message` (`blockService.blockUser` keeps the first 280). */
const BLOCK_MESSAGE_MAX = 280
/** `components/settings/blocked-users.tsx` reads the list whole; the engine pages it. */
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

interface WithdrawReportArgs {
  reportId: string
}

const blockLists = new TtlMap<string, { blockedId: string; message?: string }[]>(60_000)

/** Every one of the viewer's own blocks (`getUserBlocks`), rejecting when the read fails. */
async function ownBlocks(viewer: string): Promise<{ blockedId: string; message?: string }[]> {
  try {
    return (await blockService.getUserBlocks(viewer)).filter(block => block.blockedId)
  } catch (error) {
    throw readFailure(error)
  }
}

/**
 * Whether `docType` can be written now: false while a `notYetUsable` contract
 * (mainnet v13) has no seated team, as web's `useModeratedTypeOpen` reads it.
 * Every other contract answers without a read; a failed read rejects.
 */
async function moderatedTypeOpen(docType: string): Promise<boolean> {
  const elected = electedModeration()
  if (elected?.interim !== 'notYetUsable' || !elected.moderatedDocumentTypes[docType]) return true
  try {
    return (await moderationElectionService.getSeatedTeam()) !== null
  } catch (error) {
    throw readFailure(error)
  }
}

/**
 * Blocks and reports (`hooks/use-block.ts`, `components/settings/blocked-users.tsx`,
 * `components/moderation/report-post-modal.tsx`). The NSFW and media gates
 * run in RN; following other users' block lists is post-1.0.
 */
export function createSafetyModule(tickets: TicketStore) {
  /** The viewer's own block on the ticket's account; `getBlockProvenance` rejects when that list cannot be read. */
  // The block document itself: lib's block status answers from a cache its own write fills, even unconfirmed.
  const ownBlock = (expected: boolean) => relationProbe<BlockArgs>(({ viewer, ticket }) => ownBlockExists(viewer, ticketIdentity(ticket)), expected)

  // A settled block or unblock may have changed the viewer's list (an unblock that ends
  // STILL_BLOCKED did delete the own block): drop it, so the next page read (any cursor) re-reads it.
  tickets.observe(ticket => {
    if ((ticket.op === 'block' || ticket.op === 'unblock') && ticket.identityId && ticket.state !== 'pending') {
      blockLists.delete(ticket.identityId)
    }
  })

  tickets.register<BlockArgs>('block', {
    persistArgs: true,
    async run({ targetId, message }, ctx) {
      const result = await blockService.blockUser(signer(ctx), targetId, message)
      // v13: the block lands in the blocks contract (blockUser refuses when there is none).
      return fromTransitionResult(result, createdDocument(result, blocksContractId() ?? YAPPR_CONTRACT_ID, 'block'))
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

  tickets.register<WithdrawReportArgs>('report.withdraw', {
    persistArgs: true,
    async run({ reportId }, ctx) {
      const result = await reportService.withdrawReport(signer(ctx), reportId)
      // 40101: a moderator dismissed it (v9), or it was withdrawn from another device. Web says so.
      if (!result.success && isReportGoneError(result.error)) {
        return { state: 'failed', error: new RpcError(withdrawFailureMessage(result.error), 'REPORT_GONE') }
      }
      return fromTransitionResult(result)
    },
    // The default probe: the report proved absent (its `delete` document).
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
    block: async (targetId: string, options?: { message?: string } | null): Promise<WriteTicket> => submitBlock('block', targetId, options?.message),

    /**
     * Delete the viewer's own block. Fails with `STILL_BLOCKED` when a block
     * list the viewer follows (set up on web) still blocks the account, as web does.
     */
    unblock: async (targetId: string): Promise<WriteTicket> => submitBlock('unblock', targetId),

    /**
     * Every account the viewer blocked, as the web settings page lists them,
     * 30 a page, each with the message given. Rejects when the list cannot be
     * read (never an empty list). A block or unblock that settles drops the
     * list held for paging, so no page is stale.
     */
    async blocked(cursor?: string | null): Promise<Page<BlockedUserDTO>> {
      const viewer = requireViewer('The blocked list')
      return pageOfList({
        kind: 'blocked',
        key: viewer,
        cursor,
        size: BLOCKED_PAGE,
        cache: blockLists,
        load: () => ownBlocks(viewer),
        hydrate: async (slice) => {
          const users = await loadUserSummaries(slice.map(block => block.blockedId))
          return slice.flatMap(block => {
            const user = users.get(block.blockedId)
            return user ? [{ ...user, message: block.message || null }] : []
          })
        },
      })
    },

    /**
     * Whether the viewer blocks each of up to 100 accounts (own blocks and
     * followed lists; `checkBlockedBatch`). `blockedBy` tells the two apart.
     */
    async isBlocked(ids: string[]): Promise<Record<string, boolean>> {
      assertAtMost(ids, 100, 'ids')
      const blocked = await blockService.checkBlockedBatch(requireViewer('Block status'), ids)
      return Object.fromEntries(ids.map(id => [id, blocked.get(id) === true]))
    },

    /**
     * Where each of up to 100 accounts' block comes from
     * (`getBlockSourcesBatch`): `'self'` (the viewer's own block, which
     * `unblock` deletes; it wins when both apply), `'list'` (only a block list
     * the viewer follows: `unblock` cannot lift it), or `null` (not blocked).
     */
    async blockedBy(ids: string[]): Promise<Record<string, BlockSourceDTO | null>> {
      assertAtMost(ids, 100, 'ids')
      const sources = await blockService.getBlockSourcesBatch(requireViewer('Block status'), ids)
      return Object.fromEntries(ids.map(id => {
        const source = sources.get(id)
        return [id, source === 'own' ? 'self' : source === 'inherited' ? 'list' : null]
      }))
    },

    /**
     * Report a post or reply to the contract's moderators. `reason` is a code
     * from `lib/reports.ts` `REPORT_REASONS` up to `capabilities.reportReasonMax`
     * (0–8, and 9 on v13); "something else" (8) needs a note, and a note is at
     * most 500 characters. One report per reporter and target: a second fails
     * `DUPLICATE`, so read `ownReport` first, as web's dialog does. On v13 a
     * report pays `capabilities.reportFeeCredits` to the moderators. The engine
     * reads no private feeds, so its reports carry no moderators' box. Gated by
     * `capabilities.reports`.
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

    /**
     * Withdraw the viewer's own report (`ownReport().id`) on a target: the
     * reporter deletes it (`reportService.withdrawReport`), and the
     * moderators never see it again. A report that is already gone fails
     * `REPORT_GONE`, with web's message. Gated by `capabilities.reports`.
     */
    async withdrawReport(target: TargetRef, reportId: string): Promise<WriteTicket> {
      assertTarget(target)
      assertId(reportId, 'reportId')
      requireViewer('Withdrawing a report')
      if (!contractTakesReports()) throw notSupported('Withdrawing a report')
      return tickets.submit<WithdrawReportArgs>({
        op: 'report.withdraw',
        args: { reportId },
        target,
        documents: [socialDoc('report', reportId, 'delete')],
      })
    },

    /**
     * How many accounts' block lists the viewer follows (set up on web), so
     * the Blocked list mentions them only to someone who follows any.
     * Rejects when it cannot be read.
     */
    async followedBlockLists(): Promise<number> {
      const viewer = requireViewer('Block lists')
      try {
        return (await blockService.getBlockFollow(viewer))?.followedUserIds.length ?? 0
      } catch (error) {
        throw readFailure(error)
      }
    },

    /**
     * Whether a report can be filed now. False where the contract takes no
     * reports, and where it refuses them until an elected moderation team is
     * seated (a `notYetUsable` interim, `MODERATION_NOT_SEATED`) and none is,
     * so the sheet offers email before the form instead of after it. Every
     * other contract answers without a read. Rejects when the team cannot be read.
     */
    async reportsOpen(): Promise<boolean> {
      if (!contractTakesReports()) return false
      return moderatedTypeOpen('report')
    },

    /**
     * Whether posts and replies can be written now: false while the contract
     * refuses them until its first elected moderation team is seated (a
     * `notYetUsable` interim, mainnet v13), when RN shows "posting opens when
     * moderators are elected" instead of the composer. Every other contract
     * answers without a read. Rejects when the team cannot be read.
     */
    async postingOpen(): Promise<boolean> {
      return moderatedTypeOpen('post')
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
