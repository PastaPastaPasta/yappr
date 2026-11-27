import { rememberUsernameSkip } from '@/lib/username-skip'

type RegistrationResult = { label: string; success: boolean; isContested: boolean }

interface SessionLike {
  sessionEpoch(): number
  getState(): { user: { identityId: string } | null }
}

/**
 * The name a registration batch grants the user now: the first non-contested
 * success. A contested one has only joined its vote, so it never becomes the
 * session's username (nor replaces one the user owns).
 */
export function grantedUsername(results: ReadonlyArray<RegistrationResult>): string | null {
  return results.find((result) => result.success && !result.isContested)?.label ?? null
}

interface Sender { identityId: string; epoch: number; username: string | null | undefined }

/**
 * Whether the session that sent a batch is still the active one. A batch that
 * resolves after a sign-out or an account switch records nothing (#999).
 */
export function senderStillActive(sender: Sender, session: SessionLike): boolean {
  return session.getState().user?.identityId === sender.identityId && session.sessionEpoch() === sender.epoch
}

/**
 * Record a batch's outcome for the session that sent it: returns the name to
 * save as its username, or null. A user with no username whose batch only
 * joined votes goes on without one, as "Skip for now" does.
 */
export function recordRegistration(results: ReadonlyArray<RegistrationResult>, sender: Sender): string | null {
  const granted = grantedUsername(results)
  if (!granted && !sender.username && results.some((result) => result.success && result.isContested)) {
    rememberUsernameSkip(sender.identityId)
  }
  return granted
}
