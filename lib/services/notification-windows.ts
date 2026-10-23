import { YAPPR_CONTRACT_ID } from '../constants';
import type { NotificationWindow } from '../contract-topology';
import { getEvoSdk } from './evo-sdk-service';
import { queryDocumentsWithBlockTime, type QueryDocumentsOptions } from './sdk-helpers';

/**
 * Reads of the v10 notification windows (`reply.parentOwnerRecent`,
 * `post.quotedPostOwnerRecent`, and from v14 `reply.rootOwnerRecent`; see
 * `notificationWindowFor`).
 *
 * The grid is non-overlapping 3.5-day windows kept for a week (`ttl` twice
 * the range), so the last week is two windows: the current one and the one
 * before it. The node's `newest` names the current window. Its `oldest` is
 * the oldest window still CONTAINING now, which on a non-overlapping grid is
 * the same window, so the previous one is named by its start (`byStart`),
 * computed from the grid and the clock. It stays queryable for the whole of
 * the current window. Right at a boundary the clock and block time can name
 * different windows; the read then also covers the window before the one the
 * node's block time names (see readNotificationWindow), and a window the node
 * refuses as expired counts as empty.
 * Inside a window entries are ordered by recipient then document id, never
 * by time, and a raw `$createdAt >` clause may not bind the bucket key: the
 * dedupe and the since-filter are applied here. Every windowed source is a
 * stored doctype, so documents come back whole with their exact `$createdAt`.
 *
 * A poll reads at most {@link NOTIFICATION_WINDOW_MAX_PAGES} pages of each
 * window. A window with more is a pass over several polls: the read returns
 * where it stopped ({@link WindowRead.passes}), the poll hands that back with
 * its result (`NotificationResult.windowCursor`), and the next poll for the
 * same `since` continues from it. Until the pass is done the read holds the
 * poll watermark at `since` ({@link WindowRead.watermarkLimit}), because the
 * rows not yet read can be of any age. Nothing past the budget is dropped.
 */

/** Which window a read names: the node's current one, or one by its start. */
export type WindowPick = { readonly selector: 'newest' } | { readonly selector: 'byStart'; readonly startMs: number };

export const NOTIFICATION_WINDOW_PAGE = 100;
/** Pages read from each window per poll (1,000 documents); a window with more continues on the next poll. */
export const NOTIFICATION_WINDOW_MAX_PAGES = 10;

/** The node refusing a window whose entries have expired (the clock ahead of block time at a boundary). */
const WINDOW_EXPIRED = /expired|\bttl\b|no longer (queryable|available)/i;

/** A window read that ran out of its page budget, to be continued by the next poll. */
interface WindowPass {
  /** The source and recipient it reads (see {@link passOwner}). */
  readonly owner: string;
  /** The `since` it reads for. A read for another `since` starts over: the rows already read were filtered for this one. */
  readonly since: number;
  /** The window's start, so the continuation names this exact window (`byStart`) whatever the clock says. */
  readonly startMs: number;
  /** The last document id read. */
  readonly startAfter: string;
  /** The earliest block time any page of the pass was proved at (see {@link WindowRead.watermarkLimit}). */
  readonly readAtMs: number;
}

/**
 * Where the windows' passes stood when a fetch returned: hand it back to the
 * next poll for the same `since`, together with the watermark of that same
 * result, and only once that result's notifications are kept. A result that
 * is thrown away takes its cursor with it, so the pages it read are read
 * again rather than skipped. Opaque to callers.
 */
export type NotificationWindowCursor = readonly WindowPass[];

function passOwner(window: NotificationWindow, recipientId: string): string {
  return `${window.docType}|${window.index}|${recipientId}`;
}

/** What one source's windows answered this poll. */
export interface WindowRead {
  /** The documents created after `since`, each once, newest first. */
  readonly documents: Record<string, unknown>[];
  /**
   * How far the poll watermark may move for this source (Infinity: no limit). A window still mid-pass (its next pages wait for the next poll)
   * keeps it at `since`. A window read to its end allows the earliest block
   * time its pages were proved at: a row created after that, in a later block,
   * may have landed among ids already read, or been missing from a node a
   * block behind, but its `$createdAt` is later still, so the next poll's
   * filter keeps it (the store drops the rows it repeats by id).
   */
  readonly watermarkLimit: number;
  /** The windows whose pages continue on the next poll. */
  readonly passes: WindowPass[];
}

/** Where a fetch's sources get their window passes from and report their reads to. */
export interface WindowSession {
  readonly resume: NotificationWindowCursor;
  readonly report: (read: WindowRead) => void;
}

/** The start, in milliseconds, of the window before the one containing `nowMs` (phase 0, as the contract declares). */
export function previousWindowStart(grid: NotificationWindow['grid'], nowMs: number): number {
  return windowStartOf(grid, nowMs) - grid.step * 1000;
}

/** The start of the window holding the time `ms` (phase 0). */
function windowStartOf(grid: NotificationWindow['grid'], ms: number): number {
  const stepMs = grid.step * 1000;
  return Math.floor(ms / stepMs) * stepMs;
}

/** One page of one window: the recipient pinned, the window named by `pick` on the contract's grid. */
export function notificationWindowQuery(
  window: NotificationWindow,
  pick: WindowPick,
  recipientId: string,
  startAfter?: string
): QueryDocumentsOptions {
  return {
    dataContractId: YAPPR_CONTRACT_ID,
    documentTypeName: window.docType,
    where: [[window.recipientField, '==', recipientId]],
    timeRange: [{ field: '$createdAt', ...pick, grid: { ...window.grid } }],
    limit: NOTIFICATION_WINDOW_PAGE,
    ...(startAfter ? { startAfter } : {}),
  };
}

/**
 * One window's pages this poll (not yet since-filtered), its pass when the
 * budget ran out first, and the window it read (for `newest`, the one the
 * node's block time names; unset when nothing was read).
 */
type WindowPagesRead = WindowRead & { readonly startMs?: number };

const NOTHING_READ: WindowPagesRead = { documents: [], watermarkLimit: Infinity, passes: [] };

/**
 * One window's documents naming `recipientId`, paged by `startAfter` (the last
 * document id) from where `resumed` stopped, or from the start, for at most
 * {@link NOTIFICATION_WINDOW_MAX_PAGES} pages.
 */
async function readWindow(
  window: NotificationWindow,
  pick: WindowPick,
  recipientId: string,
  since: number,
  resumed?: WindowPass
): Promise<WindowPagesRead> {
  const sdk = await getEvoSdk();
  const documents: Record<string, unknown>[] = [];
  let startAfter = resumed?.startAfter;
  let startMs = resumed?.startMs ?? (pick.selector === 'byStart' ? pick.startMs : undefined);
  let readAtMs = resumed?.readAtMs ?? Infinity;
  for (let page = 0; page < NOTIFICATION_WINDOW_MAX_PAGES; page++) {
    const { documents: batch, blockTimeMs } = await queryDocumentsWithBlockTime(sdk, notificationWindowQuery(window, pick, recipientId, startAfter));
    // The limit and the window of a `newest` read both come from it: never continue without.
    if (!Number.isFinite(blockTimeMs)) throw new Error(`notification window: ${window.docType} answer carries no block time`);
    documents.push(...batch);
    readAtMs = Math.min(readAtMs, blockTimeMs);
    // `newest` is the window holding the node's block time, as the node resolves it.
    startMs ??= windowStartOf(window.grid, blockTimeMs);
    if (batch.length < NOTIFICATION_WINDOW_PAGE) return { documents, watermarkLimit: readAtMs, passes: [], startMs };
    const lastId = batch[batch.length - 1].$id;
    if (typeof lastId !== 'string' || !lastId || lastId === startAfter) {
      throw new Error(`notification window: ${window.docType} page cursor did not advance`);
    }
    startAfter = lastId;
  }
  if (startMs === undefined || startAfter === undefined) {
    throw new Error(`notification window: ${window.docType} read no page to continue after`);
  }
  return {
    documents,
    watermarkLimit: since,
    startMs,
    passes: [{ owner: passOwner(window, recipientId), since, startMs, startAfter, readAtMs }],
  };
}

function isExpiredWindow(error: unknown): boolean {
  return WINDOW_EXPIRED.test(error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error));
}

/**
 * The source's documents naming `recipientId` created after `since`, across
 * the current and the previous window (read in parallel), each document once,
 * newest first, with how far the poll watermark may move for them and the
 * windows to continue next poll. A window with a pass in `resume` for this
 * source, recipient and `since` continues where that pass stopped; any other
 * pass is ignored.
 *
 * The previous window is named from the clock, so it is read in parallel with
 * the current one, and checked against the window the node's block time
 * named. When they disagree at a boundary (the clock behind: the clock's
 * previous window has expired and the chain's previous one is the clock's
 * current; the clock ahead: `newest` is the clock's previous window), the
 * chain's previous window is read as well. A previous window that ended by
 * `since` holds nothing newer and is not read.
 */
export async function readNotificationWindow(
  window: NotificationWindow,
  recipientId: string,
  since: number,
  resume: NotificationWindowCursor = [],
  nowMs = Date.now()
): Promise<WindowRead> {
  const owner = passOwner(window, recipientId);
  const stepMs = window.grid.step * 1000;
  const previousStart = previousWindowStart(window.grid, nowMs);
  const saved = resume.filter((pass) => pass.owner === owner && pass.since === since);
  const passAt = (startMs: number) => saved.find((pass) => pass.startMs === startMs);
  const currentPass = saved.filter((pass) => pass.startMs > previousStart).sort((a, b) => b.startMs - a.startMs)[0];
  /** A window by its start: nothing when it ended by `since`, empty when the node says it expired (its entries are gone). */
  const readClosed = (startMs: number): Promise<WindowPagesRead> => since >= startMs + stepMs
    ? Promise.resolve(NOTHING_READ)
    : readWindow(window, { selector: 'byStart', startMs }, recipientId, since, passAt(startMs)).catch((error: unknown): WindowPagesRead => {
      if (isExpiredWindow(error)) return NOTHING_READ;
      throw error;
    });
  const [current, before] = await Promise.all([
    readWindow(window, currentPass ? { selector: 'byStart', startMs: currentPass.startMs } : { selector: 'newest' }, recipientId, since, currentPass),
    readClosed(previousStart),
  ]);
  const chainPrevious = current.startMs === undefined ? previousStart : current.startMs - stepMs;
  const extra = chainPrevious === previousStart ? NOTHING_READ : await readClosed(chainPrevious);

  // With the clock ahead at a boundary, `newest` is the clock's previous window, which that read covers.
  const passes = [...before.passes, ...extra.passes, ...current.passes.filter((pass) => pass.startMs !== previousStart)];
  // Continuing a pass, this poll read no `newest`: a later window's rows, all
  // created after this window's end, wait for the next poll.
  const unreadLater = currentPass ? currentPass.startMs + stepMs - 1 : Infinity;
  return {
    documents: createdAfter(uniqueById([...current.documents, ...before.documents, ...extra.documents]), since)
      .sort((a, b) => Number(b.$createdAt) - Number(a.$createdAt)),
    watermarkLimit: Math.min(unreadLater, current.watermarkLimit, before.watermarkLimit, extra.watermarkLimit),
    passes,
  };
}

/** {@link readNotificationWindow}'s documents, the read itself reported to `session` (if any). */
export async function readNotificationWindowDocuments(
  window: NotificationWindow,
  recipientId: string,
  since: number,
  session?: WindowSession
): Promise<Record<string, unknown>[]> {
  const read = await readNotificationWindow(window, recipientId, since, session?.resume);
  session?.report(read);
  return read.documents;
}

/** The first occurrence of each `$id` (a document without one is kept as is). */
function uniqueById(documents: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  return documents.filter((doc) => {
    if (doc.$id === undefined) return true;
    if (seen.has(doc.$id)) return false;
    seen.add(doc.$id);
    return true;
  });
}

/** Documents whose `$createdAt` is strictly after `since`. */
export function createdAfter(documents: Record<string, unknown>[], since: number): Record<string, unknown>[] {
  return documents.filter((doc) => Number(doc.$createdAt) > since);
}
