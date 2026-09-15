/**
 * Utility for resolving user details (DPNS username and display name) from identity IDs.
 * Used across settings components to avoid duplicated resolution logic.
 */

export interface UserDetails {
  id: string
  username?: string
  displayName: string
  hasDpns: boolean
}

/**
 * Resolves DPNS username and profile display name for a given identity ID.
 * Returns a standardized UserDetails object.
 */
export async function resolveUserDetailsBatch(identityIds: string[]): Promise<Map<string, UserDetails>> {
  const { loadIdentityBatch } = await import('@/lib/services/identity-batch')
  const { usernames, profiles } = await loadIdentityBatch(identityIds)
  const byOwner = new Map(profiles.map(profile => [profile.$ownerId, profile]))
  return new Map(identityIds.map(id => [id, {
    id,
    username: usernames.get(id) || undefined,
    displayName: byOwner.get(id)?.displayName || `User ${id.slice(-6)}`,
    hasDpns: !!usernames.get(id),
  }]))
}
