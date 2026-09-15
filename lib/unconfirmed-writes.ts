/**
 * The documents this session created but could not prove landed.
 *
 * `createDocument` normally waits for its transition to execute in a block, so a
 * successful create means the document is already queryable and anything may
 * reference it immediately. DAPI's confirmation wait times out routinely though,
 * and on that path the app optimistically reports success (the broadcast almost
 * always did land) without any proof.
 *
 * On the v3 topology that gap has teeth: every reference between documents is
 * `refersTo`-checked by consensus, so a like, reply or quote naming a parent that
 * has not landed is rejected outright — and its token cost is spent on the
 * rejection. So the ids from that path are recorded here, and the few writes that
 * would reference them wait for the parent to become visible first.
 *
 * Nothing is recorded on the happy path, so nothing waits on it.
 */

import { logger } from '@/lib/logger';
import { YAPPR_CONTRACT_ID } from '@/lib/constants';
import { referencesAreEnforced } from '@/lib/contract-topology';

/** documentId -> the doctype it was created in. */
const unconfirmed = new Map<string, string>();

/**
 * Record a create whose confirmation could not be obtained.
 *
 * A no-op where consensus does not check references (v2): there, a like or reply
 * naming a document that has not landed yet is accepted, so making the user wait
 * for a probe — or refusing the write — would be a pure regression on a path the
 * DAPI-504 timeout makes common.
 */
export function markUnconfirmed(documentType: string, documentId: string): void {
  if (!referencesAreEnforced()) return;
  unconfirmed.set(documentId, documentType);
}

/** True when this session wrote `documentId` and never saw it confirmed. */
export function isUnconfirmed(documentId: string | undefined): boolean {
  return Boolean(documentId && unconfirmed.has(documentId));
}

/**
 * Wait for a previously-unconfirmed document to become queryable.
 *
 * Returns true immediately for anything not on the list (the overwhelmingly
 * common case). On success the id is forgotten, so only the first dependent write
 * pays the probe. On failure the id stays listed and the caller should abort
 * rather than spend a fee on a write consensus will reject.
 */
export async function settleUnconfirmed(documentId: string | undefined): Promise<boolean> {
  if (!documentId) return true;
  const documentType = unconfirmed.get(documentId);
  if (!documentType) return true;

  const { stateTransitionService } = await import('@/lib/services/state-transition-service');
  const landed = await stateTransitionService.waitForDocument(YAPPR_CONTRACT_ID, documentType, documentId);
  if (landed) {
    unconfirmed.delete(documentId);
  } else {
    logger.warn(`settleUnconfirmed: ${documentType} ${documentId} is still not visible`);
  }
  return landed;
}
