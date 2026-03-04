import { useLoginModal } from '@/hooks/use-login-modal'

/**
 * Prompt user to re-enter their private key.
 * Called from services when private key is missing mid-session.
 *
 * This handles the case where a user appears logged in but their
 * private key has been deleted from storage (manually, by another tab, etc.)
 *
 * Opens the login modal to let the user re-enter their key without losing context
 * (DM conversations, scroll position, etc.)
 */
export function promptForAuthKey(): void {
  const { open } = useLoginModal.getState()
  open()
}
