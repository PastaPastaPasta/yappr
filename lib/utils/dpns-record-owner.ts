import { identifierToBase58 } from '@/lib/services/sdk-helpers';

/**
 * The identity a DPNS `domain` document names, but only when that identity
 * also owns the document; otherwise null.
 *
 * Platform's DPNS data trigger checks only the legacy `records.dashUniqueIdentityId`
 * and `records.dashAliasIdentityId` against the owner. The deployed schema has
 * just `records.identity`, which nothing checks, so any identity can register a
 * name whose `records.identity` points at someone else. Such a name would show
 * up in the victim's reverse lookup (`records.identity == victim`) and resolve
 * forward to the victim. A name only counts for the identity that registered it
 * (a transferred name, whose owner changed but whose record did not, counts for
 * neither).
 */
export function dpnsRecordOwner(doc: Record<string, unknown>): string | null {
  const data = (doc.data || doc) as Record<string, unknown>;
  const records = data.records as Record<string, unknown> | undefined;
  const named = identifierToBase58(records?.identity || records?.dashUniqueIdentityId || records?.dashAliasIdentityId);
  const owner = identifierToBase58(doc.$ownerId || doc.ownerId || data.$ownerId);
  return named && named === owner ? named : null;
}
