import { YAPPR_CONTRACT_ID } from '../constants';
import type { NotificationWindow } from '../contract-topology';
import { getEvoSdk } from './evo-sdk-service';
import { queryDocuments, type QueryDocumentsOptions } from './sdk-helpers';

/**
 * Reads of the v10 notification windows (`reply.parentOwnerRecent`,
 * `post.quotedPostOwnerRecent`; see `notificationWindowFor`).
 *
 * The grid is non-overlapping 3.5-day windows kept for a week (`ttl` twice
 * the range), so the last week is two windows: the current one and the one
 * before it. The node's `newest` names the current window. Its `oldest` is
 * the oldest window still CONTAINING now, which on a non-overlapping grid is
 * the same window, so the previous one is named by its start (`byStart`),
 * computed from the grid and the clock. It stays queryable for the whole of
 * the current window; if the clock runs ahead of block time right at a
 * boundary the node refuses it as expired, and that read counts as empty.
 * Inside a window entries are ordered by recipient then document id, never
 * by time, and a raw `$createdAt >` clause may not bind the bucket key: the
 * dedupe and the since-filter are applied here and the caller sorts newest
 * first. Every windowed source is a stored doctype, so documents come back
 * whole with their exact `$createdAt`.
 */

/** Which window a read names: the node's current one, or one by its start. */
export type WindowPick = { readonly selector: 'newest' } | { readonly selector: 'byStart'; readonly startMs: number };

export const NOTIFICATION_WINDOW_PAGE = 100;
/** Pages read from each stored window while each comes back full (1,000 documents). */
export const NOTIFICATION_WINDOW_MAX_PAGES = 10;

/** The node refusing a window whose entries have expired (the clock ahead of block time at a boundary). */
const WINDOW_EXPIRED = /expired|\bttl\b|no longer (queryable|available)/i;

/** The start, in milliseconds, of the window before the one containing `nowMs` (phase 0, as the contract declares). */
export function previousWindowStart(grid: NotificationWindow['grid'], nowMs: number): number {
  const stepMs = grid.step * 1000;
  return (Math.floor(nowMs / stepMs) - 1) * stepMs;
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
 * One window's documents naming `recipientId`. Pages by `startAfter` (the last
 * document id) while a page comes back full, up to
 * {@link NOTIFICATION_WINDOW_MAX_PAGES}; past that cap the rest of the window
 * is dropped, in id order rather than oldest first.
 */
async function readWindow(window: NotificationWindow, pick: WindowPick, recipientId: string): Promise<Record<string, unknown>[]> {
  const sdk = await getEvoSdk();
  const documents: Record<string, unknown>[] = [];
  let startAfter: string | undefined;
  for (let page = 0; page < NOTIFICATION_WINDOW_MAX_PAGES; page++) {
    const batch = await queryDocuments(sdk, notificationWindowQuery(window, pick, recipientId, startAfter));
    documents.push(...batch);
    const lastId = batch[batch.length - 1]?.$id;
    if (batch.length < NOTIFICATION_WINDOW_PAGE || typeof lastId !== 'string' || !lastId) break;
    startAfter = lastId;
  }
  return documents;
}

/**
 * The source's documents naming `recipientId` created after `since`, across
 * the current and the previous window (read in parallel), each document once.
 */
export async function readNotificationWindow(window: NotificationWindow, recipientId: string, since: number, nowMs = Date.now()): Promise<Record<string, unknown>[]> {
  const previous: WindowPick = { selector: 'byStart', startMs: previousWindowStart(window.grid, nowMs) };
  const [current, before] = await Promise.all([
    readWindow(window, { selector: 'newest' }, recipientId),
    readWindow(window, previous, recipientId).catch((error: unknown) => {
      if (WINDOW_EXPIRED.test(error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error))) return [];
      throw error;
    }),
  ]);
  return createdAfter(uniqueById([...current, ...before]), since);
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
