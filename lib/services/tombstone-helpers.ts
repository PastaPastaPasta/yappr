/**
 * Tombstone-by-edit: the "delete" path for permanent documents.
 *
 * The v3 topology declares `post` and `reply` as `canBeDeleted: false` (so that
 * every `refersTo` reference to them stays resolvable forever) and
 * `documentsMutable: true`. Consensus therefore rejects a delete outright, and
 * removing a post means *replacing* it with an empty one flagged `deleted: true`.
 *
 * This deliberately does NOT go through `BaseDocumentService.update()`. That
 * method rebuilds the replacement from `extractContentFields(transformedDoc)`,
 * and a transformed `Post`/`Reply` is a UI shape: it carries `author`, `likes`,
 * `createdAt` as a `Date`, `media` as an array of objects, base58 strings where
 * the contract wants raw bytes, and it has already dropped contract properties
 * the UI does not use (`language`). Feeding that back into a replace
 * either fails validation or silently rewrites the document into something else.
 *
 * So the replacement is built from the RAW document instead, keeping only the
 * properties the caller names — which for a tombstone is just the ones the
 * contract requires.
 */

import { logger } from '@/lib/logger';
import type { TombstonePreservation } from '@/lib/contract-topology';
import { isImmutablePropertyChangedError } from '@/lib/error-utils';
import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import { documentToPlainObject, identifierToBase58, identifierStringToDocumentBytes } from './sdk-helpers';

export interface TombstoneParams {
  contractId: string;
  documentType: string;
  documentId: string;
  ownerId: string;
  /**
   * The properties to carry over verbatim, from
   * {@link tombstonePreservationFor}. Identifiers are re-encoded to raw bytes,
   * which is what the typed write path expects; scalars are copied as-is, and
   * an absent one stays absent (an untagged post has no `hashtag`, a direct
   * reply no `replyToReplyId`).
   *
   * From contract v7 this set is the doctype's consensus-`immutable` list, so
   * omitting an entry is no longer a silent field loss: a replace that DROPS a
   * frozen property is rejected with 40128 exactly like one that changes it.
   */
  preserve: TombstonePreservation;
}

/**
 * Replace a document with a tombstone: empty content, `deleted: true`, and
 * nothing else beyond the named required fields. Returns false (without
 * throwing) when the document cannot be read or the replace is rejected.
 */
export async function tombstoneDocument(params: TombstoneParams): Promise<boolean> {
  const { contractId, documentType, documentId, ownerId } = params;

  try {
    const sdk = await getEvoSdk();
    const existing = await sdk.documents.get(contractId, documentType, documentId);
    if (!existing) {
      logger.error(`Cannot tombstone ${documentType} ${documentId}: document not found`);
      return false;
    }

    const raw = documentToPlainObject(existing);
    const data = (raw.data || raw) as Record<string, unknown>;
    const revision = Number(raw.$revision ?? 0);

    // content is `minLength: 0` on both doctypes, so the empty string is a valid
    // value rather than a removal — which matters, because `content` being absent
    // and `content` being blank are different documents.
    const replacement: Record<string, unknown> = { content: '', deleted: true };

    for (const field of params.preserve.identifiers) {
      const base58 = identifierToBase58(data[field] ?? raw[field]);
      if (base58) replacement[field] = identifierStringToDocumentBytes(base58);
    }
    for (const field of params.preserve.scalars) {
      const value = data[field] ?? raw[field];
      if (value !== undefined && value !== null) replacement[field] = value;
    }

    const result = await stateTransitionService.updateDocument(
      contractId,
      documentType,
      documentId,
      ownerId,
      replacement,
      revision
    );

    if (!result.success) {
      // 40128 here means the preserve set above is missing a property the
      // contract freezes — a contract/descriptor drift bug, not a user or
      // network problem, so name it rather than letting it read as a
      // transient failure.
      if (isImmutablePropertyChangedError(result.error)) {
        logger.error(
          `Failed to tombstone ${documentType} ${documentId}: the replacement dropped or changed an immutable ` +
            `property, so tombstonePreservationFor('${documentType}') is out of sync with the contract.`,
          result.error
        );
      } else {
        logger.error(`Failed to tombstone ${documentType} ${documentId}:`, result.error);
      }
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error tombstoning ${documentType} ${documentId}:`, error);
    return false;
  }
}
