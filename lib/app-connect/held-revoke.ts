/**
 * A wallet revoke found while the same identity renews is held back: the
 * wallet disables the old keys before the renewal's grant arrives, so the
 * renewal's outcome decides (#738). It is bound to the session it was found
 * on (the controller's session epoch at the time).
 */
export interface HeldRevoke {
  identityId: string
  epoch: number
}

/**
 * What a held revoke comes to when the renewal state changes from
 * `previousRenewing` to `renewing`: `wait` while that renewal is still under
 * way; `drop` once it ended but another sign-in or a sign-out has replaced
 * the session it was found on (so it ends nothing that is still here);
 * otherwise `sign-out`, the sign-out it owes (which still stands down if the
 * renewal's new grant is active by then).
 */
export function settleHeldRevoke(
  held: HeldRevoke,
  previousRenewing: string | null,
  renewing: string | null,
  epochNow: number,
): 'wait' | 'drop' | 'sign-out' {
  if (previousRenewing !== held.identityId || renewing === held.identityId) return 'wait'
  return epochNow === held.epoch ? 'sign-out' : 'drop'
}
