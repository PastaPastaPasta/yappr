import type { PlatformAuthIntent } from 'platform-auth'
import { hasSkippedUsername } from '@/lib/username-skip'

/**
 * Where a sign-in goes next: the username prompt, the sign-in page, or nowhere.
 * `stay` leaves the user on the page they signed in from; /login and the
 * landing page send a signed-in viewer on by themselves.
 */
export type SignInDestination =
  | { kind: 'username-prompt'; identityId: string }
  | { kind: 'stay' }
  | { kind: 'route'; href: '/login' }

/**
 * The next step after a sign-in or sign-out intent. An identity whose holder
 * chose "skip for now" on this browser is not asked for a username again
 * (lib/username-skip.ts).
 */
export function signInDestination(intent: PlatformAuthIntent): SignInDestination {
  switch (intent.kind) {
    case 'username-required':
      return hasSkippedUsername(intent.identityId)
        ? { kind: 'stay' }
        : { kind: 'username-prompt', identityId: intent.identityId }
    // The controller's profile gate is off, so `profile-required` never comes.
    case 'profile-required':
    case 'ready':
      return { kind: 'stay' }
    case 'logged-out':
      return { kind: 'route', href: '/login' }
  }
}
