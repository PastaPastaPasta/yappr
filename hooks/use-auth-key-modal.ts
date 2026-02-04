'use client'

import { create } from 'zustand'

interface AuthKeyModalStore {
  isOpen: boolean
  onSuccess?: () => void
  onCancel?: () => void
  open: (onSuccess?: () => void, onCancel?: () => void) => void
  close: () => void
  /** Close the modal after successful key entry (doesn't call onCancel) */
  closeWithSuccess: () => void
}

/**
 * Global store for the auth key re-entry modal.
 * Use this to prompt users to re-enter their private key when it's
 * been deleted from storage mid-session.
 *
 * This preserves user context (DM conversations, scroll position, etc.)
 * instead of forcing a disruptive logout.
 */
export const useAuthKeyModal = create<AuthKeyModalStore>((set, get) => ({
  isOpen: false,
  onSuccess: undefined,
  onCancel: undefined,
  open: (onSuccess?: () => void, onCancel?: () => void) =>
    set({ isOpen: true, onSuccess, onCancel }),
  close: () => {
    const { onCancel } = get()
    if (onCancel) {
      onCancel()
    }
    set({ isOpen: false, onSuccess: undefined, onCancel: undefined })
  },
  closeWithSuccess: () => {
    const { onSuccess } = get()
    if (onSuccess) {
      onSuccess()
    }
    set({ isOpen: false, onSuccess: undefined, onCancel: undefined })
  },
}))
