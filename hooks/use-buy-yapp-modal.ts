import { createModalStore } from '@/lib/modal-store'
import { isInsufficientTokenError } from '@/lib/error-utils'
import { yappIsLocked } from '@/lib/contract-topology'
import { useStarterGrantModal } from '@/hooks/use-starter-grant-modal'

/**
 * Which signing path the Buy-YAPP modal takes once an amount is confirmed.
 * - 'local': sign with the stored login key, falling back to asking for a
 *   CRITICAL key when the login key is HIGH.
 * - 'wallet': go straight to the dash-st: QR for a remote wallet to sign.
 *   Used right after a wallet (key-exchange) login: the wallet that just
 *   approved the login holds the CRITICAL key, and asking the user to paste
 *   one into the browser is exactly what that flow exists to avoid.
 */
export type BuyYappSigning = 'local' | 'wallet'

interface BuyYappPayload {
  /** Optional reason shown at the top (e.g. "You need YAPP to post"). */
  reason: string | null
  signing: BuyYappSigning
}

export const useBuyYappModal = createModalStore<BuyYappPayload, [reason?: string, signing?: BuyYappSigning]>(
  { reason: null, signing: 'local' },
  (reason, signing) => ({ reason: reason ?? null, signing: signing ?? 'local' })
)

/**
 * If `error` is an insufficient-YAPP failure, open the Buy-YAPP modal with
 * `reason` and return true (handled). Otherwise return false so the caller can
 * surface its own error. Shared by post/reply/like/repost failure paths.
 *
 * Where YAPP cannot be bought (v10) the starter-grant modal opens instead: it
 * offers the one-time grant, or says why there is no way to get more. The
 * `reason` is dropped there: callers word it for the Buy-YAPP modal.
 */
export function handleInsufficientYapp(error: unknown, reason: string): boolean {
  if (!isInsufficientTokenError(error)) return false
  if (yappIsLocked()) useStarterGrantModal.getState().open()
  else useBuyYappModal.getState().open(reason)
  return true
}
