import { logger } from '@/lib/logger';
import { extractErrorMessage } from '../error-utils';
import { YAPPR_CONTRACT_ID } from '../constants';
import { contractTakesReports, reportShape, reportsAreResolved } from '../contract-topology';
import { ABOUT_PROFILE, toReportRecord, type ReportRecord, type ReportTargetKind, type ReportView } from '../reports';
import { getEvoSdk } from './evo-sdk-service';
import { queryRawDocuments } from './document-service';
import { paginateFetchAll } from './pagination-utils';
import { identifierStringToDocumentBytes, type DocumentOrderByClause, type DocumentWhereClause } from './sdk-helpers';
import { stateTransitionService, type StateTransitionResult } from './state-transition-service';

/**
 * The equality clauses that pin a report's target: `postId` or `replyId`
 * (v13 `byPost` / `byReply`, which serve the target's reports and, with
 * `$ownerId` after them, the reporter's own), or a profile report's
 * `targetOwnerId == T && about == 1` (`byTarget`).
 */
function targetClauses(kind: ReportTargetKind, targetId: string): DocumentWhereClause[] {
  if (kind === 'profile') return [['targetOwnerId', '==', targetId], ['about', '==', ABOUT_PROFILE]];
  return [[kind === 'post' ? 'postId' : 'replyId', '==', targetId]];
}

/** Reports on one target read before a dismissal; each one is its own moderation transition. */
const MAX_REPORTS_PER_TARGET = 500;

export interface ReportInput {
  kind: ReportTargetKind;
  /** The post or reply; for a profile report the reported identity (the same as `targetOwnerId`). */
  targetId: string;
  /** The target's author: consensus refuses anyone else (40127), and the reporter (10419). */
  targetOwnerId: string;
  reason: number;
  /** Omitted when blank; required for "something else". */
  note?: string;
  /** v13, a private post or reply only: the moderators' key to it (`lib/report-box.ts`). */
  box?: Uint8Array;
}

/**
 * Why consensus would refuse a report of this shape, or null: a profile
 * report where the contract takes none, one whose target is not the identity
 * it names, a box on a profile report (`boxOnContent`) or a box the contract
 * would not hold.
 */
export function reportInputShapeProblem(input: Pick<ReportInput, 'kind' | 'targetId' | 'targetOwnerId' | 'box'>): string | null {
  const { profiles, boxMaxBytes } = reportShape();
  if (input.kind === 'profile') {
    if (!profiles) return 'Profiles cannot be reported on this network';
    if (input.targetId !== input.targetOwnerId) return 'A profile report names the reported identity as its target';
    if (input.box) return 'A profile report carries no box';
  }
  if (input.box && (boxMaxBytes === null || input.box.length === 0 || input.box.length > boxMaxBytes)) {
    return boxMaxBytes === null ? 'Reports carry no box on this network' : `The moderators' box is over ${boxMaxBytes} bytes`;
  }
  return null;
}

const records = (docs: Record<string, unknown>[]): ReportRecord[] =>
  docs.map(toReportRecord).filter((report): report is ReportRecord => report !== null);

/**
 * Where the next page of the queue starts: the last report of the previous
 * one, and the value it was ordered by (`$createdAt`, or `$moderatedAt` for a
 * moderator's history).
 */
export interface ReportCursor {
  id: string;
  createdAt: number;
}

/**
 * How a {@link ReportView} is read (v10): the index's equality clause and the
 * property the page is ordered by. `byStatus` does not skip a missing
 * `status`, so the open queue reads it with `status == null`: a missing value
 * is indexed under the empty key, which a null equality reaches.
 */
function viewQuery(view: ReportView): { equal: DocumentWhereClause[]; orderBy: '$createdAt' | '$moderatedAt' } {
  switch (view.kind) {
    case 'open':
      return { equal: [['status', '==', null]], orderBy: '$createdAt' };
    case 'status':
      return { equal: [['status', '==', view.status]], orderBy: '$createdAt' };
    case 'moderatedBy':
      return { equal: [['$moderatedBy', '==', view.moderatorId]], orderBy: '$moderatedAt' };
  }
}

const orderValueOf = (report: ReportRecord, orderBy: '$createdAt' | '$moderatedAt'): number =>
  orderBy === '$moderatedAt' ? report.moderatedAt ?? 0 : report.createdAt;

/** Drive refused a `startAfter` naming a document that no longer exists (StartDocumentNotFound). */
const isCursorGoneError = (error: unknown): boolean =>
  /startafter document not found|startdocumentnotfound/i.test(extractErrorMessage(error));

/**
 * Reports on the social contract (v9/v10 `report`, see `lib/reports.ts`). The
 * writes are the reporter's; a moderator's dismissal or resolution is a
 * moderation transition and lives in `moderationService.dismissReports` /
 * `resolveReports`. Off a topology that takes reports, every write refuses
 * locally and every read answers nothing.
 */
class ReportService {
  /**
   * The reporter's own report on a target, or null when there is none.
   * THROWS when the read fails, so a caller never offers a second report
   * (a paid 40105) because it could not check for the first.
   */
  async getOwnReport(reporterId: string, kind: ReportTargetKind, targetId: string): Promise<ReportRecord | null> {
    if (!contractTakesReports()) return null;
    if (kind === 'profile' && !reportShape().profiles) return null;
    // The unique index's own order: target first on v13, the reporter first before it.
    const owner: DocumentWhereClause = ['$ownerId', '==', reporterId];
    const target = targetClauses(kind, targetId);
    const docs = await queryRawDocuments({
      dataContractId: YAPPR_CONTRACT_ID,
      documentTypeName: 'report',
      where: reportShape().targetFirst ? [...target, owner] : [owner, ...target],
      limit: 1,
    });
    return records(docs)[0] ?? null;
  }

  /**
   * File a report. On v13 a report pays the contract's moderators action fee
   * (50M credits), which the create agrees to from the contract JSON
   * (`declaredActionFee('report', 'create')`).
   */
  async fileReport(reporterId: string, input: ReportInput): Promise<StateTransitionResult> {
    if (!contractTakesReports()) return { success: false, error: 'This contract takes no reports' };
    const problem = reportInputShapeProblem(input);
    if (problem) return { success: false, error: problem };
    const note = input.note?.trim();
    const target = input.kind === 'profile'
      ? { about: ABOUT_PROFILE }
      : { [input.kind === 'post' ? 'postId' : 'replyId']: identifierStringToDocumentBytes(input.targetId) };
    return stateTransitionService.createDocument(YAPPR_CONTRACT_ID, 'report', reporterId, {
      ...target,
      targetOwnerId: identifierStringToDocumentBytes(input.targetOwnerId),
      reason: input.reason,
      ...(note ? { note } : {}),
      ...(input.box ? { box: input.box } : {}),
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

  /**
   * One page of the queue as `view` lists it, newest first, after `cursor`;
   * `next` is set while more may follow. Where reports are resolved (v10) the
   * open queue and a status read `byStatus`, a moderator's history
   * `byModerator`. Elsewhere (v9) every report is open and this is
   * {@link listRecent}.
   *
   * A cursor naming a report that is gone resumes at its order value, as
   * {@link listRecent} does, so callers dedupe by id.
   */
  async listView(view: ReportView, cursor?: ReportCursor, limit = 100): Promise<{ reports: ReportRecord[]; next?: ReportCursor }> {
    if (!contractTakesReports()) return { reports: [] };
    if (!reportsAreResolved()) return view.kind === 'open' ? this.listRecent(cursor, limit) : { reports: [] };
    const { equal, orderBy } = viewQuery(view);
    const page = (where: DocumentWhereClause[], startAfter?: string) => queryRawDocuments({
      dataContractId: YAPPR_CONTRACT_ID,
      documentTypeName: 'report',
      where: [...equal, ...where],
      orderBy: [...equal.map(([field]): DocumentOrderByClause => [field, 'asc']), [orderBy, 'desc']],
      limit,
      ...(startAfter ? { startAfter } : {}),
    });
    let docs: Record<string, unknown>[];
    try {
      docs = await page([[orderBy, '>', 0]], cursor?.id);
    } catch (error) {
      if (!cursor || !isCursorGoneError(error)) throw error;
      docs = await page([[orderBy, '<=', cursor.createdAt]]);
    }
    const reports = records(docs);
    const last = reports[reports.length - 1];
    return { reports, ...(docs.length === limit && last ? { next: { id: last.id, createdAt: orderValueOf(last, orderBy) } } : {}) };
  }

  /** Every report on one post, reply (`byPost` / `byReply`) or profile (`byTarget`), up to {@link MAX_REPORTS_PER_TARGET}. */
  async listForTarget(kind: ReportTargetKind, targetId: string): Promise<ReportRecord[]> {
    if (!contractTakesReports()) return [];
    const sdk = await getEvoSdk();
    const { documents } = await paginateFetchAll(
      sdk,
      () => ({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: 'report',
        where: targetClauses(kind, targetId),
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
