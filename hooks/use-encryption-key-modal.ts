'use client'

import { createModalStore } from '@/lib/modal-store'

export type EncryptionKeyAction =
  | 'view_private_posts'
  | 'create_private_post'
  | 'manage_private_feed'
  | 'decrypt_grant'
  | 'recover_follower_keys'
  | 'sync_state'
  | 'generic'

interface EncryptionKeyPayload {
  action: EncryptionKeyAction
  /** Runs after the key has been entered and stored, not on dismissal. */
  onSuccess?: () => void
}

/**
 * Prompts the user for their encryption key when a private-feed operation
 * needs it. `action` picks the explanatory copy.
 */
export const useEncryptionKeyModal = createModalStore<EncryptionKeyPayload, [action?: EncryptionKeyAction, onSuccess?: () => void]>(
  { action: 'generic', onSuccess: undefined },
  (action = 'generic', onSuccess) => ({ action, onSuccess })
)

/** A human-readable phrase for what the key unlocks. */
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
