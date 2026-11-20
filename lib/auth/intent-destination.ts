import type { PlatformAuthIntent } from 'platform-auth'
import { hasSkippedUsername } from '@/lib/username-skip'

/** Where a sign-in goes next: the username prompt, or a route. */
export type SignInDestination =
  | { kind: 'username-prompt'; identityId: string }
  | { kind: 'route'; href: '/feed' | '/login' }

/**
 * The next step after a sign-in or sign-out intent. An identity whose holder
 * chose "skip for now" on this browser goes straight to the feed instead of
 * being asked for a username again (lib/username-skip.ts).
 */
export function signInDestination(intent: PlatformAuthIntent): SignInDestination {
  switch (intent.kind) {
    case 'username-required':
      return hasSkippedUsername(intent.identityId)
        ? { kind: 'route', href: '/feed' }
        : { kind: 'username-prompt', identityId: intent.identityId }
    // The controller's profile gate is off, so `profile-required` never comes.
    case 'profile-required':
    case 'ready':
      return { kind: 'route', href: '/feed' }
    case 'logged-out':
      return { kind: 'route', href: '/login' }
  }
}
