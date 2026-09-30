import { YAPPR_CONTRACT_ID } from '../constants';
import type { NotificationWindow } from '../contract-topology';
import { getEvoSdk } from './evo-sdk-service';
import { queryDocuments, type QueryDocumentsOptions } from './sdk-helpers';

/**
 * Reads of the v10 notification windows (`reply.parentOwnerRecent`,
 * `post.quotedPostOwnerRecent`; see `notificationWindowFor`).
 *
 * The grid is non-overlapping 3.5-day windows kept for a week, so the last
 * week is the two open windows: the current one (`newest`) and the previous
 * one (`oldest`), each resolved by the node and each its own query. Right
 * after a boundary both may name the same window, so documents are deduped by
 * id. Inside a window, entries are ordered by recipient then document id,
 * never by time, and a raw `$createdAt >` clause may not bind the bucket key.
 * So the since-filter is applied here and the caller sorts newest first. Every
 * windowed source is a stored doctype, so documents come back whole with their
 * exact `$createdAt`.
 */

type WindowSelector = NotificationWindow['selectors'][number];

export const NOTIFICATION_WINDOW_PAGE = 100;
/** Pages read from each stored window while each comes back full. */
export const NOTIFICATION_WINDOW_MAX_PAGES = 3;

/** One page of one window: the recipient pinned, the window named by `selector` on the contract's grid. */
export function notificationWindowQuery(
  window: NotificationWindow,
  selector: WindowSelector,
  recipientId: string,
  startAfter?: string
): QueryDocumentsOptions {
  return {
    dataContractId: YAPPR_CONTRACT_ID,
    documentTypeName: window.docType,
    where: [[window.recipientField, '==', recipientId]],
    timeRange: [{ field: '$createdAt', selector, grid: { ...window.grid } }],
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
async function readWindow(window: NotificationWindow, selector: WindowSelector, recipientId: string): Promise<Record<string, unknown>[]> {
  const sdk = await getEvoSdk();
  const documents: Record<string, unknown>[] = [];
  let startAfter: string | undefined;
  for (let page = 0; page < NOTIFICATION_WINDOW_MAX_PAGES; page++) {
    const batch = await queryDocuments(sdk, notificationWindowQuery(window, selector, recipientId, startAfter));
    documents.push(...batch);
    const lastId = batch[batch.length - 1]?.$id;
    if (batch.length < NOTIFICATION_WINDOW_PAGE || typeof lastId !== 'string' || !lastId) break;
    startAfter = lastId;
  }
  return documents;
}

/**
 * The source's documents naming `recipientId` created after `since`, across
 * both open windows (read in parallel), each document once.
 */
export async function readNotificationWindow(window: NotificationWindow, recipientId: string, since: number): Promise<Record<string, unknown>[]> {
  const perWindow = await Promise.all(window.selectors.map((selector) => readWindow(window, selector, recipientId)));
  return createdAfter(uniqueById(perWindow.flat()), since);
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
