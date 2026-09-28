import { logger } from '@/lib/logger';
import { extractErrorMessage } from '../error-utils';
import { YAPPR_CONTRACT_ID } from '../constants';
import { contractTakesReports, type TargetKind } from '../contract-topology';
import { toReportRecord, type ReportRecord } from '../reports';
import { getEvoSdk } from './evo-sdk-service';
import { queryRawDocuments } from './document-service';
import { paginateFetchAll } from './pagination-utils';
import { identifierStringToDocumentBytes, type DocumentWhereClause } from './sdk-helpers';
import { stateTransitionService, type StateTransitionResult } from './state-transition-service';

/** The property naming a report's target, and the unique index it shares with `$ownerId`. */
const targetField = (kind: TargetKind) => (kind === 'post' ? 'postId' : 'replyId');

/** Reports on one target read before a dismissal; each one is its own moderation transition. */
const MAX_REPORTS_PER_TARGET = 500;

export interface ReportInput {
  kind: TargetKind;
  targetId: string;
  /** The target's author: consensus refuses anyone else (40127), and the reporter (10419). */
  targetOwnerId: string;
  reason: number;
  /** Omitted when blank; required for "something else". */
  note?: string;
}

const records = (docs: Record<string, unknown>[]): ReportRecord[] =>
  docs.map(toReportRecord).filter((report): report is ReportRecord => report !== null);

/** Where the next page of the queue starts: the last report of the previous one. */
export interface ReportCursor {
  id: string;
  createdAt: number;
}

/** Drive refused a `startAfter` naming a document that no longer exists (StartDocumentNotFound). */
const isCursorGoneError = (error: unknown): boolean =>
  /startafter document not found|startdocumentnotfound/i.test(extractErrorMessage(error));

/**
 * Reports on the social contract (v9 `report`, see `lib/reports.ts`). The
 * writes are the reporter's; a moderator's dismissal is a moderation
 * transition and lives in `moderationService.dismissReports`. Off a topology
 * that takes reports, every write refuses locally and every read answers
 * nothing.
 */
class ReportService {
  /**
   * The reporter's own report on a target, or null when there is none.
   * THROWS when the read fails, so a caller never offers a second report
   * (a paid 40105) because it could not check for the first.
   */
  async getOwnReport(reporterId: string, kind: TargetKind, targetId: string): Promise<ReportRecord | null> {
    if (!contractTakesReports()) return null;
    const docs = await queryRawDocuments({
      dataContractId: YAPPR_CONTRACT_ID,
      documentTypeName: 'report',
      where: [['$ownerId', '==', reporterId], [targetField(kind), '==', targetId]],
      limit: 1,
    });
    return records(docs)[0] ?? null;
  }

  async fileReport(reporterId: string, input: ReportInput): Promise<StateTransitionResult> {
    if (!contractTakesReports()) return { success: false, error: 'This contract takes no reports' };
    const note = input.note?.trim();
    return stateTransitionService.createDocument(YAPPR_CONTRACT_ID, 'report', reporterId, {
      [targetField(input.kind)]: identifierStringToDocumentBytes(input.targetId),
      targetOwnerId: identifierStringToDocumentBytes(input.targetOwnerId),
      reason: input.reason,
      ...(note ? { note } : {}),
    });
  }

  /**
   * The reporter deletes its own report; moderators never see it again. A report
   * carries a 90-day \`ttl\`, so it refunds nothing, and a delete after it expired
   * (before the platform's cleanup reached it) still passes: only a replace or a
   * restore is refused (40140), and a report is never replaced.
   */
  async withdrawReport(reporterId: string, reportId: string): Promise<StateTransitionResult> {
    if (!contractTakesReports()) return { success: false, error: 'This contract takes no reports' };
    return stateTransitionService.deleteDocument(YAPPR_CONTRACT_ID, 'report', reportId, reporterId);
  }

  /**
   * One page of reports, newest first (`byTime`), after `cursor` (the `next`
   * of the previous page); `next` is set while more may follow.
   *
   * The cursor's report may be gone by the time the next page is asked for
   * (dismissed, or withdrawn), and Drive refuses a `startAfter` naming a
   * missing document. The page then resumes at the cursor's block time
   * instead, so reports of that same block may come back again: callers
   * dedupe by id.
   */
  async listRecent(cursor?: ReportCursor, limit = 100): Promise<{ reports: ReportRecord[]; next?: ReportCursor }> {
    if (!contractTakesReports()) return { reports: [] };
    const page = (where: DocumentWhereClause[], startAfter?: string) => queryRawDocuments({
      dataContractId: YAPPR_CONTRACT_ID,
      documentTypeName: 'report',
      where,
      orderBy: [['$createdAt', 'desc']],
      limit,
      ...(startAfter ? { startAfter } : {}),
    });
    let docs: Record<string, unknown>[];
    try {
      docs = await page([['$createdAt', '>', 0]], cursor?.id);
    } catch (error) {
      if (!cursor || !isCursorGoneError(error)) throw error;
      docs = await page([['$createdAt', '<=', cursor.createdAt]]);
    }
    const reports = records(docs);
    const last = reports[reports.length - 1];
    return { reports, ...(docs.length === limit && last ? { next: { id: last.id, createdAt: last.createdAt } } : {}) };
  }

  /** Every report on one post or reply (`byPost` / `byReply`), up to {@link MAX_REPORTS_PER_TARGET}. */
  async listForTarget(kind: TargetKind, targetId: string): Promise<ReportRecord[]> {
    if (!contractTakesReports()) return [];
    const sdk = await getEvoSdk();
    const { documents } = await paginateFetchAll(
      sdk,
      () => ({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'report',
        where: [[targetField(kind), '==', targetId]],
      }),
      (doc) => doc,
      { maxResults: MAX_REPORTS_PER_TARGET }
    );
    const reports = records(documents);
    if (reports.length >= MAX_REPORTS_PER_TARGET) {
      logger.warn(`reportService: ${kind} ${targetId} has at least ${MAX_REPORTS_PER_TARGET} reports; only that many are read at once`);
    }
    return reports;
  }
}

export const reportService = new ReportService();
