import { readScoped, writeScoped } from '@/lib/storage-scope'

/**
 * "Skip for now" on the username step, remembered per identity on this
 * browser so pages that ask for a username stop sending the user back to it.
 * It survives sign-out: the choice belongs to the identity, not the session.
 */
const skipKey = (identityId: string) => `yappr_skip_dpns:${identityId}`

export function hasSkippedUsername(identityId: string): boolean {
  return readScoped(skipKey(identityId)) === '1'
}

export function rememberUsernameSkip(identityId: string): void {
  writeScoped(skipKey(identityId), '1')
}
