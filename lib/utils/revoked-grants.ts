/**
 * Drop grants that a revocation in this session already removed. Each revoked
 * follower maps to the `$createdAt` of the grant that was revoked, so a stale
 * read of that grant stays hidden while a later re-approval (a new grant with a
 * newer `$createdAt`) shows again.
 */
export function withoutRevokedGrants<T extends { recipientId: string; grantedAt: number }>(
  grants: T[],
  revokedGrantedAt: ReadonlyMap<string, number>
): T[] {
  return grants.filter((grant) => {
    const revokedAt = revokedGrantedAt.get(grant.recipientId)
    return revokedAt === undefined || grant.grantedAt > revokedAt
  })
}
