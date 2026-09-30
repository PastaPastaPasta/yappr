import { YAPPR_CONTRACT_ID } from '@/lib/constants';
import type { TargetKind } from '@/lib/contract-topology';
import { queryRawDocuments } from '@/lib/services/document-service';
import { chunk, MAX_IN_CLAUSE_VALUES } from '@/lib/services/pagination-utils';

/**
 * The ids among `ids` that a proved `$id in` query on `kind` does not return.
 *
 * Batch lookups elsewhere fall back to per-id reads that treat a failed read
 * as "absent", so a hole is only reported once this query proves it. A failed
 * query proves nothing and reports nothing for its batch.
 */
export async function provenAbsent(kind: TargetKind, ids: readonly string[]): Promise<Set<string>> {
  const absent = new Set<string>();
  for (const batch of chunk(Array.from(new Set(ids)), MAX_IN_CLAUSE_VALUES)) {
    try {
      const found = await queryRawDocuments({
        dataContractId: YAPPR_CONTRACT_ID,
        documentTypeName: kind,
        where: [['$id', 'in', batch]],
        limit: batch.length,
      });
      const present = new Set(found.map((doc) => doc.$id));
      batch.filter((id) => !present.has(id)).forEach((id) => absent.add(id));
    } catch {
      // Unproven: the caller keeps claiming nothing for these ids.
    }
  }
  return absent;
}
