import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE } from '@/lib/constants';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import { logger } from '@/lib/logger';
import { dpnsService } from './dpns-service';
import { unifiedProfileService } from './unified-profile-service';
import { profileSources } from '@/lib/profile/v10-profile';
import { queryDocumentBundle } from './document-query-bundle';
import type { QueryDocumentsOptions } from './sdk-helpers';
import { chunk, mapLimit } from './pagination-utils';

/** A name does not require a Yappr profile. Query the requested identities as
 * independent siblings, so profile-less users keep their names. Reuse either
 * service's existing cache; bundle identities missing either cached result. */
export async function loadIdentityBatch(identityIds: string[], options: { includeUsername?: boolean } = {}) {
  const includeUsername = options.includeUsername ?? true;
  const ids = Array.from(new Set(identityIds.filter(Boolean)));
  if (likesAreIndexOnly() && includeUsername) {
    const cold = ids.filter(id => !dpnsService.hasCachedUsername(id) || !unifiedProfileService.hasCachedProfile(id));
    // One query per profile document type (v10: the DashPay profile and the extension).
    const sources = profileSources();
    await mapLimit(chunk(cold, 40), 2, async batch => {
      try {
        const results = await queryDocumentBundle([
          ...sources.map(({ source }): QueryDocumentsOptions => ({ dataContractId: source.contractId, documentTypeName: source.documentType,
            where: [['$ownerId', 'in', batch]], orderBy: [['$ownerId', 'asc']], limit: batch.length })),
          { dataContractId: DPNS_CONTRACT_ID, documentTypeName: DPNS_DOCUMENT_TYPE,
            where: [['records.identity', 'in', batch]], orderBy: [['records.identity', 'asc']], limit: 100 },
        ]);
        const profiles = results.slice(0, sources.length);
        const names = results[sources.length];
        // Validate the complete response before seeding either service.
        const { usernamesByIdentity } = await import('@/lib/feed/composite-feed-page');
        sources.forEach(({ role }, i) => unifiedProfileService.seedProfileDocuments(profiles[i], batch, role));
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
