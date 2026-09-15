import { likesAreIndexOnly } from '@/lib/contract-topology';
import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { chunk, mapLimit } from './pagination-utils';
import { documentToPlainObject, queryDocuments, type QueryDocumentsOptions } from './sdk-helpers';

/** Explicit sibling queries: callers must use compatible index walk directions
 * and distinct index paths. Keeps every query's own limit and ordering; unlike
 * an IN query, a busy branch cannot consume another branch's page budget.
 * Cursors stay on the ordinary surface. No failed proof seeds partial results. */
export async function queryDocumentBundle(queries: QueryDocumentsOptions[], tolerateFailures = false): Promise<Record<string, unknown>[][]> {
  if (queries.length === 0) return [];
  const sdk = await getEvoSdk();
  const groups = await mapLimit(chunk(queries, 11), 2, async batch => {
    if (likesAreIndexOnly() && batch.length > 1 && batch.every(q => q.limit && !q.startAt && !q.startAfter)) {
      const [page, ...siblings] = batch;
      try {
        const result = await sdk.documents.composite({
          dataContractId: page.dataContractId,
          documentType: page.documentTypeName,
          where: page.where, orderBy: page.orderBy, limit: page.limit ?? 100,
          subQueries: siblings.map(query => ({
            dataContractId: query.dataContractId, documentType: query.documentTypeName,
            where: query.where, orderBy: query.orderBy, limit: query.limit,
          })),
        });
        if (!Array.isArray(result.pageDocuments) || !Array.isArray(result.subResults) ||
            result.subResults.length !== siblings.length ||
            result.subResults.some(sub => sub.kind !== 'documents' || !Array.isArray(sub.documents))) {
          throw new Error('Incomplete composite sibling response');
        }
        return [result.pageDocuments, ...result.subResults.map(sub => sub.kind === 'documents' ? sub.documents : [])]
          .map(documents => documents.map(documentToPlainObject));
      } catch (error) {
        logger.warn('Composite siblings failed; retrying individual queries', error);
      }
    }
    // Keep independent failures isolated, as the original service readers did.
    return mapLimit(batch, 3, async query => {
      try {
        return await queryDocuments(sdk, query);
      } catch (error) {
        if (!tolerateFailures) throw error;
        logger.error('Document bundle member failed', query.documentTypeName, error);
        return [];
      }
    });
  });
  return groups.flat();
}
