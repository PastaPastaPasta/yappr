import type { PlatformAuthIntent } from 'platform-auth'
import { hasSkippedUsername } from '@/lib/username-skip'

/**
 * What a sign-in or sign-out leads to: the username prompt, a finished sign-in,
 * or a sign-out. Where each one goes is the auth context's call: a sign-in on
 * /login goes on to its `next`, and one from the sign-in sheet stays on the page.
 */
export type SignInDestination =
  | { kind: 'username-prompt'; identityId: string }
  | { kind: 'signed-in' }
  | { kind: 'signed-out' }

/**
 * The next step after a sign-in or sign-out intent. An identity whose holder
 * chose "skip for now" on this browser is not asked for a username again
 * (lib/username-skip.ts).
 */
export function signInDestination(intent: PlatformAuthIntent): SignInDestination {
  switch (intent.kind) {
    case 'username-required':
      return hasSkippedUsername(intent.identityId)
        ? { kind: 'signed-in' }
        : { kind: 'username-prompt', identityId: intent.identityId }
    // The controller's profile gate is off, so `profile-required` never comes.
    case 'profile-required':
    case 'ready':
      return { kind: 'signed-in' }
    case 'logged-out':
      return { kind: 'signed-out' }
  }
}
