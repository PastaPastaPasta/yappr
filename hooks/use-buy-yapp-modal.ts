import { create } from 'zustand'
import { isInsufficientTokenError } from '@/lib/error-utils'

interface BuyYappModalStore {
  isOpen: boolean
  /** Optional reason shown at the top (e.g. "You need YAPP to post"). */
  reason: string | null
  open: (reason?: string) => void
  close: () => void
}

export const useBuyYappModal = create<BuyYappModalStore>((set) => ({
  isOpen: false,
  reason: null,
  open: (reason) => set({ isOpen: true, reason: reason ?? null }),
  close: () => set({ isOpen: false, reason: null }),
}))

/**
 * If `error` is an insufficient-YAPP failure, open the Buy-YAPP modal with
 * `reason` and return true (handled). Otherwise return false so the caller can
 * surface its own error. Shared by post/reply/like/repost failure paths.
 */
export function handleInsufficientYapp(error: unknown, reason: string): boolean {
  if (isInsufficientTokenError(error)) {
    useBuyYappModal.getState().open(reason)
    return true
  }
  return false
}
