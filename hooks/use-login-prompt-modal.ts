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

/**
 * Get a human-readable description for each action type
 * @deprecated No longer used - login modal doesn't show action-specific messages
 */
export function getActionDescription(action: LoginPromptAction): string {
  switch (action) {
    case 'like':
      return 'like posts'
    case 'repost':
      return 'repost'
    case 'quote':
      return 'quote posts'
    case 'bookmark':
      return 'bookmark posts'
    case 'tip':
      return 'send tips'
    case 'reply':
      return 'reply to posts'
    case 'post':
      return 'create posts'
    case 'follow':
      return 'follow users'
    case 'block':
      return 'block users'
    case 'message':
      return 'send messages'
    case 'view_following':
      return 'see posts from people you follow'
    case 'delete':
      return 'delete posts'
    case 'generic':
    default:
      return 'perform this action'
  }
}
