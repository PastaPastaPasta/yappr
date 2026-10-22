/** Where a profile page's read of its own moderation (`yapprProfile` `mod`) stands. */
export type ProfileModerationRead = 'pending' | 'done' | 'failed'

/**
 * What the profile page does about that read now:
 * - `{ settle }`: nothing to read; the read stands at `settle`;
 * - `'read'`: read it now.
 *
 * Off a hide cut, or with no profile id, there is nothing to read (`done`).
 * Until the SDK is ready nothing is read: the read waits (`pending`, the
 * header keeps its skeleton). A cold signed-out visit mounts before the SDK
 * is configured, and reading then fails for every profile. If the SDK never
 * comes up, the read has failed (`failed`, fail closed).
 */
export function profileModerationReadStep(state: {
  hidesProfiles: boolean
  userId: string | null
  sdkReady: boolean
  sdkError: string | null
}): { settle: ProfileModerationRead } | 'read' {
  if (!state.hidesProfiles || !state.userId) return { settle: 'done' }
  if (!state.sdkReady) return { settle: state.sdkError ? 'failed' : 'pending' }
  return 'read'
}
