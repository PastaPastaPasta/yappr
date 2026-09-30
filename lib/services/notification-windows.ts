import { YAPPR_CONTRACT_ID } from '../constants';
import type { NotificationWindow } from '../contract-topology';
import { getEvoSdk } from './evo-sdk-service';
import { queryDocuments, type QueryDocumentsOptions } from './sdk-helpers';

/**
 * Reads of the v10 rolling notification windows (`reply.parentOwnerRecent`,
 * `post.quotedPostOwnerRecent`; see
 * `notificationWindowFor`).
 *
 * Inside a window, entries are ordered by recipient then document id, never
 * by time, and a raw `$createdAt >` clause may not bind the bucket key. So a
 * read fetches the window and filters `> since` here; the caller sorts
 * newest first. Every windowed source is a stored doctype, so documents come
 * back whole with their exact `$createdAt`.
 */

export const NOTIFICATION_WINDOW_PAGE = 100;
/** Pages read from a stored window while each comes back full (300 events a week). */
export const NOTIFICATION_WINDOW_MAX_PAGES = 3;

/** One page of a window: the recipient pinned, the oldest open window on the contract's grid. */
export function notificationWindowQuery(window: NotificationWindow, recipientId: string, startAfter?: string): QueryDocumentsOptions {
  return {
    dataContractId: YAPPR_CONTRACT_ID,
    documentTypeName: window.docType,
    where: [[window.recipientField, '==', recipientId]],
    timeRange: [{ field: '$createdAt', selector: window.selector, grid: { ...window.grid } }],
    limit: NOTIFICATION_WINDOW_PAGE,
    ...(startAfter ? { startAfter } : {}),
  };
}

/**
 * The window's documents naming `recipientId` created after `since`. Pages by
 * `startAfter` (the last document id) while a page comes back full, up to
 * {@link NOTIFICATION_WINDOW_MAX_PAGES}; past that cap the rest of the week is
 * dropped, in id order rather than oldest first.
 */
export async function readNotificationWindow(window: NotificationWindow, recipientId: string, since: number): Promise<Record<string, unknown>[]> {
  const sdk = await getEvoSdk();
  const documents: Record<string, unknown>[] = [];
  let startAfter: string | undefined;
  for (let page = 0; page < NOTIFICATION_WINDOW_MAX_PAGES; page++) {
    const batch = await queryDocuments(sdk, notificationWindowQuery(window, recipientId, startAfter));
    documents.push(...batch);
    const lastId = batch[batch.length - 1]?.$id;
    if (batch.length < NOTIFICATION_WINDOW_PAGE || typeof lastId !== 'string' || !lastId) break;
    startAfter = lastId;
  }
  return createdAfter(documents, since);
}

/** Documents whose `$createdAt` is strictly after `since`. */
export function createdAfter(documents: Record<string, unknown>[], since: number): Record<string, unknown>[] {
  return documents.filter((doc) => Number(doc.$createdAt) > since);
}
