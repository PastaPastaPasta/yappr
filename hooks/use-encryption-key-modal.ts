'use client'

import { create } from 'zustand'

export type EncryptionKeyAction =
  | 'view_private_posts'
  | 'create_private_post'
  | 'manage_private_feed'
  | 'decrypt_grant'
  | 'recover_follower_keys'
  | 'sync_state'
  | 'generic'

interface EncryptionKeyModalStore {
  isOpen: boolean
  action: EncryptionKeyAction
  onSuccess?: () => void
  onCancel?: () => void
  open: (action?: EncryptionKeyAction, onSuccess?: () => void, onCancel?: () => void) => void
  close: () => void
  /** Close the modal after successful key entry (doesn't call onCancel) */
  closeWithSuccess: () => void
}

/**
 * Global store for the encryption key entry modal.
 * Use this to prompt users to enter their encryption key when they try to perform
 * private feed operations that require it.
 */
export const useEncryptionKeyModal = create<EncryptionKeyModalStore>((set, get) => ({
  isOpen: false,
  action: 'generic',
  onSuccess: undefined,
  onCancel: undefined,
  open: (action = 'generic', onSuccess?: () => void, onCancel?: () => void) => set({ isOpen: true, action, onSuccess, onCancel }),
  close: () => {
    const { onCancel } = get()
    // Call onCancel if modal is being closed without success (user cancelled/dismissed)
    if (onCancel) {
      onCancel()
    }
    set({ isOpen: false, action: 'generic', onSuccess: undefined, onCancel: undefined })
  },
  closeWithSuccess: () => {
    // Close without calling onCancel (used after successful key entry)
    set({ isOpen: false, action: 'generic', onSuccess: undefined, onCancel: undefined })
  },
}))

/**
 * Get a human-readable description for each action type
 */
export function getEncryptionKeyActionDescription(action: EncryptionKeyAction): string {
  switch (action) {
    case 'view_private_posts':
      return 'view private posts'
    case 'create_private_post':
      return 'create private posts'
    case 'manage_private_feed':
      return 'manage your private feed'
    case 'decrypt_grant':
      return 'access private feeds you follow'
    case 'recover_follower_keys':
      return 'recover access to private feeds on this device'
    case 'sync_state':
      return 'sync your private feed state'
    case 'generic':
    default:
      return 'use private feed features'
  }
}
