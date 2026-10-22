import { restrictionServiceFor } from '@/lib/services/restriction-service'

interface IdentityState {
  user: { identityId: string } | null
}

/**
 * Forgets every cached restriction standing (social and blog) whenever the
 * signed-in identity changes: a sign-out by any route (the button, a wallet
 * revoke, another tab) or a switch to another account. A standing is read once
 * per session and kept, so one left behind would put the next account's posts
 * in the wrong lane. Returns the unsubscribe.
 */
export function clearRestrictionsOnIdentityChange(
  current: IdentityState,
  subscribe: (listener: (state: IdentityState) => void) => () => void,
): () => void {
  let identityId = current.user?.identityId ?? null
  return subscribe((state) => {
    const next = state.user?.identityId ?? null
    if (next === identityId) return
    identityId = next
    restrictionServiceFor('social').clear()
    restrictionServiceFor('blog').clear()
  })
}
