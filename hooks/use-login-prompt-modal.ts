'use client'

import { useLoginModal } from './use-login-modal'

export type LoginPromptAction =
  | 'like'
  | 'repost'
  | 'quote'
  | 'bookmark'
  | 'tip'
  | 'reply'
  | 'post'
  | 'follow'
  | 'block'
  | 'message'
  | 'view_following'
  | 'delete'
  | 'generic'

/**
 * @deprecated Use useLoginModal directly instead.
 * This hook now just forwards to useLoginModal for backwards compatibility.
 */
export const useLoginPromptModal = () => {
  const loginModal = useLoginModal()

  return {
    isOpen: loginModal.isOpen,
    action: 'generic' as LoginPromptAction,
    open: (_action?: LoginPromptAction) => loginModal.open(),
    close: () => loginModal.close(),
  }
}
