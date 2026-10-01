import { isReferenceNotFoundError } from '@/lib/error-utils';
import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { identifierToBase58, normalizeSDKResponse, identifierStringToDocumentBytes } from './sdk-helpers';
import { dpnsService } from './dpns-service';
import { paginateFetchAll } from './pagination-utils';
import { mentionDocTypes, mentionsAreInline, type TargetKind } from '../contract-topology';
import { withoutHiddenTombstones } from '../feed/hidden-tombstones';
import type { Post } from '../../types';
import type { PreloadedEnrichment } from '@/hooks/use-progressive-enrichment';

export interface PostMentionDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  /** The mentioning post, or on v10 the mentioning reply (see `targetKind`). */
  postId: string;
  mentionedUserId: string;
  /** v10: `reply` when the mention is a reply's own `mentionedUserId`; a post otherwise. */
  targetKind?: TargetKind;
}

/**
 * On the v9 contract `postMention.mentionedUserId` declares `refersTo: identity`.
 * Mentions are written fire-and-forget after a post lands, so there is no UI to
 * fail — but the reason must be legible in the log, because it means DPNS
 * resolved a name to an identity that is not (or is no longer) on chain, not
 * that the write flaked.
 */
function logMentionReferenceRejected(mentionedUserId: string, cause: unknown): void {
  logger.warn(
    'MentionService: Platform rejected the mention — the mentioned identity does not exist on chain:',
    mentionedUserId,
    cause
  );
}

class MentionService extends BaseDocumentService<PostMentionDocument> {
  constructor() {
    super('postMention');
  }

  /** v10: a post or reply naming the user in `mentionedUserId`, as a mention record (the document IS the mention). */
  private mentionFromDocument(doc: Record<string, unknown>, userId: string, targetKind: TargetKind): PostMentionDocument {
    const $id = doc.$id as string;
    return {
      $id, $ownerId: doc.$ownerId as string, $createdAt: Number(doc.$createdAt), postId: $id, mentionedUserId: userId,
      ...(targetKind === 'reply' ? { targetKind } : {}),
    };
  }

  /**
   * Transform document from SDK response to typed object
   * System identifier fields arrive as base58, while identifier-like document fields may
   * arrive as base64 or raw bytes in query results.
   */
  protected transformDocument(doc: Record<string, unknown>): PostMentionDocument {
    const data = (doc.data || doc) as Record<string, unknown>;
    const rawPostId = data.postId || doc.postId;
    const rawMentionedUserId = data.mentionedUserId || doc.mentionedUserId;

    // Normalize identifier-like fields to base58 for app-level use.
    const postId = rawPostId ? identifierToBase58(rawPostId) : '';
    const mentionedUserId = rawMentionedUserId ? identifierToBase58(rawMentionedUserId) : '';

    if (rawPostId && !postId) {
      logger.error('MentionService: Invalid postId format:', rawPostId);
    }
    if (rawMentionedUserId && !mentionedUserId) {
      logger.error('MentionService: Invalid mentionedUserId format:', rawMentionedUserId);
    }

    return {
      $id: doc.$id as string,
      $ownerId: doc.$ownerId as string,
      $createdAt: doc.$createdAt as number,
      postId: postId || '',
      mentionedUserId: mentionedUserId || ''
    };
  }

  /**
   * Create a single mention document for a post
   */
  async createPostMention(postId: string, ownerId: string, mentionedUserId: string): Promise<boolean> {
    if (mentionsAreInline()) {
      // v10: no postMention doctype. The post's one indexed mention is written
      // with the post itself (postService.createPost) and cannot be added later.
      logger.warn('MentionService: mentions are inline on this contract; no mention document to create');
      return false;
    }
    if (!postId) {
      logger.warn('MentionService: Invalid postId');
      return false;
    }
    if (!mentionedUserId) {
      logger.warn('MentionService: Invalid mentionedUserId');
      return false;
    }

    try {
      // Check if already exists (unique index on postId + mentionedUserId)
      const existing = await this.getMentionForPost(postId, mentionedUserId);
      if (existing) {
        logger.debug('Mention already exists for post:', mentionedUserId);
        return true;
      }

      // Typed writes use Uint8Array for identifier-like fields.
      let postIdBytes: Uint8Array;
      let mentionedUserIdBytes: Uint8Array;

      try {
        postIdBytes = identifierStringToDocumentBytes(postId);
      } catch (decodeError) {
        logger.error('MentionService: Invalid base58 postId:', postId, decodeError);
        return false;
      }

      try {
        mentionedUserIdBytes = identifierStringToDocumentBytes(mentionedUserId);
      } catch (decodeError) {
        logger.error('MentionService: Invalid base58 mentionedUserId:', mentionedUserId, decodeError);
        return false;
      }

      // Create document via state transition
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        ownerId,
        {
          postId: postIdBytes,
          mentionedUserId: mentionedUserIdBytes
        }
      );

      if (!result.success && isReferenceNotFoundError(result.error)) {
        logMentionReferenceRejected(mentionedUserId, result.error);
        return false;
      }

      return result.success;
    } catch (error) {
      if (isReferenceNotFoundError(error)) {
        logMentionReferenceRejected(mentionedUserId, error);
        return false;
      }
      logger.error('Error creating mention:', error);
      return false;
    }
  }

  /**
   * Create multiple mention documents for a post from username list
   * Resolves usernames to identity IDs via DPNS
   */
  async createPostMentionsFromUsernames(
    postId: string,
    ownerId: string,
    usernames: string[]
  ): Promise<boolean[]> {
    const results: boolean[] = [];

    // Deduplicate usernames (case-insensitive)
    const uniqueUsernames = Array.from(new Set(
      usernames.map(u => u.toLowerCase())
    ));

    for (const username of uniqueUsernames) {
      try {
        // Resolve username to identity ID via DPNS
        const identityId = await dpnsService.resolveIdentity(username);
        if (!identityId) {
          logger.warn('MentionService: Could not resolve username:', username);
          results.push(false);
          continue;
        }

        // createPostMention never throws: a reference rejection (DPNS resolved
        // the name, but the identity behind it is not on chain) is logged there
        // and comes back as false. Anything reaching this catch came from the
        // DPNS lookup above.
        const result = await this.createPostMention(postId, ownerId, identityId);
        results.push(result);
      } catch (error) {
        logger.error('Error creating mention for username:', username, error);
        results.push(false);
      }
    }

    return results;
  }

  /**
   * Get a specific mention document for a post
   */
  async getMentionForPost(postId: string, mentionedUserId: string): Promise<PostMentionDocument | null> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Use strings for identifiers in queries - SDK handles conversion
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['postId', '==', postId],
          ['mentionedUserId', '==', mentionedUserId]
        ],
        limit: 1
      });

      // Use shared helper for response normalization
      const documents = normalizeSDKResponse(response);
      return documents.length > 0 ? this.transformDocument(documents[0]) : null;
    } catch (error) {
      logger.error('Error getting mention for post:', error);
      return null;
    }
  }

  /**
   * Get all mentions for a specific post
   */
  async getMentionsForPost(postId: string): Promise<PostMentionDocument[]> {
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Raw query path: postId is identifier-like, so keep the base58 string operand.
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['postId', '==', postId]
        ],
        limit: 100
      });

      // Use shared helper for response normalization
      const documents = normalizeSDKResponse(response);
      return documents.map((doc) => this.transformDocument(doc));
    } catch (error) {
      logger.error('Error getting mentions for post:', error);
      return [];
    }
  }

  /**
   * Get posts that mention a specific user.
   * Paginates through all results to return complete list.
   * Returns mention documents - caller should fetch actual posts and filter by
   * ownership ({@link loadMentioningPosts}).
   *
   * v10: the mentioning posts AND replies themselves, off their permanent
   * `mentionedUserAndTime [mentionedUserId, $createdAt]` (the same walk as
   * `postMention`'s), read in parallel and merged newest first, mapped onto
   * the mention shape with `postId` = the document's id, `$ownerId` its
   * author and `targetKind` its kind.
   */
  async getPostsMentioningUser(userId: string): Promise<PostMentionDocument[]> {
    const inline = mentionsAreInline();
    try {
      const sdk = await import('../services/evo-sdk-service').then(m => m.getEvoSdk());

      // Use strings for identifiers in queries - SDK handles conversion
      const perType = await Promise.all(mentionDocTypes().map(async (documentTypeName) => (await paginateFetchAll(
        sdk,
        () => ({
          dataContractId: this.contractId,
          documentTypeName,
          where: [
            ['mentionedUserId', '==', userId],
            ['$createdAt', '>', 0]
          ],
          orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'asc']]
        }),
        (doc) => inline ? this.mentionFromDocument(doc, userId, documentTypeName === 'reply' ? 'reply' : 'post') : this.transformDocument(doc)
      )).documents));

      return perType.length === 1 ? perType[0] : perType.flat().sort((a, b) => b.$createdAt - a.$createdAt);
    } catch (error) {
      logger.error('Error getting posts mentioning user:', error);
      return [];
    }
  }

  /**
   * The posts (and v10 replies, rendered through the Post shape) behind
   * `mentions`, newest first, for display: one `$id in` batch per kind. A
   * mention only counts when its document's author is the one who made it
   * (on v10 that holds by construction; on v2/v9 it drops forged
   * `postMention` records).
   */
  async loadMentioningPosts(mentions: PostMentionDocument[]): Promise<{ posts: Post[]; preloaded: PreloadedEnrichment }> {
    const { postService, replyToPost } = await import('./post-service');
    const idsOf = (kind: TargetKind) => Array.from(new Set(
      mentions.filter((mention) => (mention.targetKind ?? 'post') === kind).map((mention) => mention.postId)
    ));
    const replyIds = idsOf('reply');
    const [{ posts, preloaded }, replies] = await Promise.all([
      postService.getPostsByIdsForDisplay(idsOf('post')),
      replyIds.length > 0
        ? import('./reply-service').then(({ replyService }) => replyService.getRepliesByIds(replyIds))
        : [],
    ]);
    const authentic = new Set(mentions.map((mention) => `${mention.postId}:${mention.$ownerId}`));
    // v11 tombstones clear `mentionedUserId` and leave the index anyway; this
    // covers a node a block behind.
    const found = withoutHiddenTombstones([...posts, ...replies.map(replyToPost)]).filter((post) => authentic.has(`${post.id}:${post.author.id}`));
    found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { posts: found, preloaded };
  }

}

// Singleton instance
export const mentionService = new MentionService();
