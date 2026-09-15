import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE, YAPPR_PROFILE_CONTRACT_ID } from '@/lib/constants';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import { logger } from '@/lib/logger';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { queryDocumentBundle } from './document-query-bundle';
import { chunk, mapLimit } from './pagination-utils';

/** A name does not require a Yappr profile. Query the requested identities as
 * independent siblings, so profile-less users keep their names. Reuse either
 * service's existing cache; bundle identities missing either cached result. */
export async function loadIdentityBatch(identityIds: string[], options: { includeUsername?: boolean } = {}) {
  const includeUsername = options.includeUsername ?? true;
  const ids = Array.from(new Set(identityIds.filter(Boolean)));
  if (likesAreIndexOnly() && includeUsername) {
    const cold = ids.filter(id => !dpnsService.hasCachedUsername(id) || !unifiedProfileService.hasCachedProfile(id));
    await mapLimit(chunk(cold, 40), 2, async batch => {
      try {
        const [profiles, names] = await queryDocumentBundle([
          { dataContractId: YAPPR_PROFILE_CONTRACT_ID, documentTypeName: 'profile',
            where: [['$ownerId', 'in', batch]], orderBy: [['$ownerId', 'asc']], limit: batch.length },
          { dataContractId: DPNS_CONTRACT_ID, documentTypeName: DPNS_DOCUMENT_TYPE,
            where: [['records.identity', 'in', batch]], orderBy: [['records.identity', 'asc']], limit: 100 },
        ]);
        // Validate the complete response before seeding either service.
        const { usernamesByIdentity } = await import('@/lib/feed/composite-feed-page');
        unifiedProfileService.seedProfileDocuments(profiles, batch);
        dpnsService.seedUsernames(usernamesByIdentity(names, batch, batch.length));
      } catch (error) {
        logger.warn('Identity composite failed; using cached/batch identity readers', error);
      }
    });
  }
  const [usernames, profiles, avatars] = await Promise.all([
    includeUsername ? dpnsService.resolveUsernamesBatch(ids) : Promise.resolve(new Map<string, string | null>()),
    unifiedProfileService.getProfilesByIdentityIds(ids),
    unifiedProfileService.getAvatarUrlsBatch(ids),
  ]);
  return { usernames, profiles, avatars };
}
