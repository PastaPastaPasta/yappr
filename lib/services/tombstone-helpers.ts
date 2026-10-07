/**
 * Tombstone-by-edit: the "delete" path for permanent documents.
 *
 * The v9 and v11 topologies declare `post` and `reply` as `canBeDeleted: false`
 * (so that every `refersTo` reference to them stays resolvable forever) and
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
import { clearableReferencesFor, tombstoneKeepsEmptyContent, type TombstonePreservation } from '@/lib/contract-topology';
import { isBarredFromContractError, isImmutablePropertyChangedError, isReferenceNotFoundError, referencedPathFromError } from '@/lib/error-utils';
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
   * On v9 this set is the doctype's consensus-`immutable` list, so omitting
   * an entry is not a silent field loss: a replace that DROPS a
   * frozen property is rejected with 40128 exactly like one that changes it.
   */
  preserve: TombstonePreservation;
  /**
   * What the tombstone writes beyond the preserved fields, when not the social
   * contract's own ({@link tombstoneBase}). Blog v7 posts write `deleted` and
   * `commentsEnabled: false` (`BLOG_POST_TOMBSTONE`).
   */
  base?: Readonly<Record<string, unknown>>;
}

/**
 * The part of every tombstone that is not carried over from the stored
 * document. v9's `tombstoneIsBlank` reads the length of `content`, which is
 * `minLength: 0` there, so the tombstone writes it EMPTY (absent and blank are
 * different documents). v11's requires every clearable field ABSENT, so it
 * writes `deleted` alone; consensus reads the boolean as 1, which is what the
 * rule's `equal: [deleted, 1]` names.
 */
function tombstoneBase(): Record<string, unknown> {
  return tombstoneKeepsEmptyContent() ? { content: '', deleted: true } : { deleted: true };
}

/**
 * Replace a document with a tombstone: `deleted: true` ({@link tombstoneBase}:
 * plus an empty `content` on v9) and nothing else beyond the named preserved
 * fields. Returns false (without throwing) when the document cannot be read or
 * the replace is rejected.
 *
 * On v11 every content field, the quote graph and the embed are cleared; a
 * tombstoned quote or bare repost therefore stops holding its author's
 * one-quote-per-target slot and stops counting as a quote. References at a
 * post are `moderatedDocument` there and keep resolving after a removal, so
 * the dead-reference retry below never fires
 * ({@link clearableReferencesFor} is empty).
 *
 * On v9 the references a post carries are `deletableDocument` references,
 * and a replace re-validates every one of them: a quote of a post a moderator
 * has since removed cannot be tombstoned with its `quotedPostId` intact
 * (40120, ReferencedEntityNotFound). Clearing that dead reference is the one
 * change to an `immutable` property consensus allows, so a 40120 is retried
 * with EXACTLY the property the rejection names dropped — never with every
 * clearable reference dropped, because the immutable check judges each removed
 * property on its own and dropping one whose target is still alive is a 40128.
 * (A reply whose thread root was removed hits precisely that: `rootPostId` is
 * required, so it is not clearable at all, while a live `replyToReplyId`
 * beside it must be left alone.) `quotedPostOwnerId` is not a reference and
 * stays. A rejection whose path cannot be read, or that names a property the
 * contract does not let go, is reported rather than guessed at.
 *
 * THROWS the refusal when the author is banned or suspended from the contract
 * (41107/41108). On v9 and v11 Drive lets a barred identity delete but
 * refuses it every replace, a tombstone included, so on a
 * `canBeDeleted: false` type a barred author cannot take its own post down at
 * all. The caller says so (with the moderators' reason, `reportBarredWrite`)
 * instead of a silent "failed". On v12 post and reply declare
 * `retractedWhen: { present: "deleted" }` (`barredAuthorsCanTombstone()`):
 * a barred author's replace that writes `deleted` (this tombstone) is
 * accepted, and only a refusal of something else would still land here.
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
    // Already a tombstone (a stale card, or a repost undone on another tab):
    // the outcome asked for holds, and a second replace would only cost fees.
    if ((data.deleted ?? raw.deleted) === true) return true;

    const replacement = params.base ? { ...params.base } : tombstoneBase();

    for (const field of params.preserve.identifiers) {
      const stored = data[field] ?? raw[field];
      const base58 = identifierToBase58(stored);
      if (base58) replacement[field] = identifierStringToDocumentBytes(base58);
      else if (stored !== undefined && stored !== null) {
        // Present but undecodable. Dropping it is refused: 40128 when it is immutable, and on a post
        // whose embed id it is, 10422 (`embedAllOrNone`) first, since the embed's doc type stays.
        // The handler below would blame either on the descriptor, so name the real cause here.
        logger.error(
          `Tombstone of ${documentType} ${documentId}: stored ${field} could not be decoded as an ` +
            'identifier, so it cannot be preserved; the replace will be refused (10422 or 40128).'
        );
      }
    }
    for (const field of params.preserve.scalars) {
      const value = data[field] ?? raw[field];
      if (value !== undefined && value !== null) replacement[field] = value;
    }

    const replace = (fields: Record<string, unknown>) =>
      stateTransitionService.updateDocument(contractId, documentType, documentId, ownerId, fields, revision);
    let result = await replace(replacement);

    // One pass per clearable reference: a post quoting two removed documents
    // is refused once for each, and each rejection names the next one. The
    // drops accumulate on a COPY, so the first attempt's replacement — already
    // handed to the write path — is never mutated underneath it.
    const clearable = clearableReferencesFor(documentType);
    const attempt = { ...replacement };
    for (let dropped = 0; dropped < clearable.length; dropped++) {
      if (result.success || !isReferenceNotFoundError(result.error)) break;
      const path = referencedPathFromError(result.error);
      if (!path || !clearable.includes(path) || !(path in attempt)) {
        // Either the target of a reference the contract freezes for good (a
        // reply's thread root), or a phrasing this cannot read. Dropping
        // something else would trade a 40120 for a 40128 and a false
        // "descriptor drift" diagnosis below.
        break;
      }
      logger.warn(`Tombstone of ${documentType} ${documentId}: ${path} points at a removed document; retrying with it cleared.`);
      delete attempt[path];
      result = await replace(attempt);
    }

    if (!result.success && isBarredFromContractError(result.error)) {
      throw typeof result.error === 'string' ? new Error(result.error) : result.error;
    }
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
    if (isBarredFromContractError(error)) throw error;
    logger.error(`Error tombstoning ${documentType} ${documentId}:`, error);
    return false;
  }
}
