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
export async function resolveUserDetails(identityId: string): Promise<UserDetails> {
  const { dpnsService } = await import('@/lib/services/dpns-service')
  const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

  let username: string | undefined
  let displayName = `User ${identityId.slice(-6)}`
  let hasDpns = false

  // Try to get DPNS username
  try {
    const resolvedUsername = await dpnsService.resolveUsername(identityId)
    if (resolvedUsername) {
      username = resolvedUsername
      hasDpns = true
    }
  } catch {
    // DPNS resolution is optional
  }

  // Try to get profile display name
  try {
    const profile = await unifiedProfileService.getProfile(identityId)
    if (profile?.displayName) {
      displayName = profile.displayName
    }
  } catch {
    // Profile is optional
  }

  return {
    id: identityId,
    username,
    displayName,
    hasDpns,
  }
}

/**
 * Resolves user details for multiple identity IDs in parallel.
 */
export async function resolveMultipleUserDetails(identityIds: string[]): Promise<UserDetails[]> {
  return Promise.all(identityIds.map(resolveUserDetails))
}
