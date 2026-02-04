import { useAuthKeyModal } from '@/hooks/use-auth-key-modal'

/**
 * Prompt user to re-enter their private key.
 * Called from services when private key is missing mid-session.
 *
 * This handles the case where a user appears logged in but their
 * private key has been deleted from storage (manually, by another tab, etc.)
 *
 * Opens a modal to let the user re-enter their key without losing context
 * (DM conversations, scroll position, etc.)
 */
export function promptForAuthKey(onSuccess?: () => void, onCancel?: () => void): void {
  const { open } = useAuthKeyModal.getState()
  open(onSuccess, onCancel)
}
