import { YAPPR_CONTRACT_ID } from '@/lib/constants';
import { likesAreIndexOnly, likeIndexFor, postOwnerIndexPrefix, quoteFieldFor, repostIndexFor, type TargetKind } from '@/lib/contract-topology';
import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { documentToPlainObject, type DocumentWhereClause } from './sdk-helpers';
import { unifiedProfileService } from './unified-profile-service';
import { profileBaseSource } from '@/lib/profile/v10-profile';

/** Counts must bind a real document field; the API rejects unbound counts.
 * A missing root therefore needs ordinary counts, not an assumed zero. */
async function boundCounts(root: {
  contractId: string; documentType: string; where: DocumentWhereClause[]; sourceProperty: string;
}, counts: Array<{ documentType: string; field: string; where?: DocumentWhereClause[] }>) {
  const sdk = await getEvoSdk();
  const result = await sdk.documents.composite({
    dataContractId: root.contractId, documentType: root.documentType, where: root.where, limit: 1,
    subQueries: counts.map(({ documentType, field, where }) => ({
      dataContractId: YAPPR_CONTRACT_ID, documentType, kind: 'counts',
      ...(where && where.length > 0 ? { where } : {}),
      bind: { source: 'page', sourceProperty: root.sourceProperty, field },
    })),
  });
  if (!Array.isArray(result.pageDocuments) || result.subResults.length !== counts.length ||
      result.subResults.some(sub => sub.kind !== 'counts' || !(sub.counts instanceof Map))) {
    throw new Error('Incomplete summary counts proof');
  }
  return {
    documents: result.pageDocuments.map(documentToPlainObject),
    counts: result.subResults.map(sub => sub.kind === 'counts' ? sub.counts : new Map<string, bigint>()),
  };
}

export async function loadUserStats(userId: string) {
  if (likesAreIndexOnly()) {
    try {
      // The counts hang off the user's profile document (v10: the DashPay profile).
      const { contractId, documentType } = profileBaseSource();
      const result = await boundCounts({
        contractId, documentType,
        where: [['$ownerId', '==', userId]], sourceProperty: '$ownerId',
      }, [
        // v13: live posts only (`ownerAndTime` starts at `live`).
        { documentType: 'post', field: '$ownerId', where: postOwnerIndexPrefix() },
        { documentType: 'follow', field: 'followingId' },
        { documentType: 'follow', field: '$ownerId' },
      ]);
      unifiedProfileService.seedProfileDocuments(result.documents, [userId]);
      if (result.documents.length) {
        const [posts, followers, following] = result.counts.map(count => Number(count.get(userId) ?? 0n));
        return { posts, followers, following };
      }
    } catch (error) {
      logger.warn('Profile summary composite failed; using ordinary counts', error);
    }
  }
  const [{ postService }, { followService }] = await Promise.all([import('./post-service'), import('./follow-service')]);
  const [posts, followers, following] = await Promise.all([
    postService.countUserPosts(userId), followService.countFollowers(userId), followService.countFollowing(userId),
  ]);
  return { posts, followers, following };
}

export async function loadEngagementCounts(postId: string, kind: TargetKind) {
  // Null on v10, which has no repost doctype: `quotes` there counts the bare
  // reposts too, and `reposts` stays 0 (the engagements page splits the list).
  const repost = repostIndexFor(kind);
  if (likesAreIndexOnly()) {
    try {
      const like = likeIndexFor(kind);
      const result = await boundCounts({
        contractId: YAPPR_CONTRACT_ID, documentType: kind,
        where: [['$id', '==', postId]], sourceProperty: '$id',
      }, [
        { documentType: 'post', field: quoteFieldFor(kind) ?? 'quotedPostId' },
        { documentType: like.docType, field: like.field },
        ...(repost ? [{ documentType: repost.docType, field: repost.field }] : []),
      ]);
      if (result.documents.length) {
        const [quotes, likes, reposts = 0] = result.counts.map(count => Number(count.get(postId) ?? 0n));
        return { quotes, likes, reposts };
      }
    } catch (error) {
      logger.warn('Engagement counts composite failed; using ordinary counts', error);
    }
  }
  const [{ postService }, { likeService }, { repostService }] = await Promise.all([
    import('./post-service'), import('./like-service'), import('./repost-service'),
  ]);
  const [quotes, likes, reposts] = await Promise.all([
    postService.countQuotes(postId, kind), likeService.countLikes(postId, kind),
    repost ? repostService.countReposts(postId) : Promise.resolve(0),
  ]);
  return { quotes, likes, reposts };
}
