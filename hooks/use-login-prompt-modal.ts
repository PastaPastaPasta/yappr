'use client'

import { create } from 'zustand'

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
  | 'generic'

interface LoginPromptModalStore {
  isOpen: boolean
  action: LoginPromptAction
  open: (action?: LoginPromptAction) => void
  close: () => void
}

/**
 * Global store for the login prompt modal.
 * Use this to prompt users to log in when they try to perform
 * actions that require authentication.
 */
export const useLoginPromptModal = create<LoginPromptModalStore>((set) => ({
  isOpen: false,
  action: 'generic',
  open: (action = 'generic') => set({ isOpen: true, action }),
  close: () => set({ isOpen: false, action: 'generic' }),
}))

/**
 * Get a human-readable description for each action type
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
    case 'generic':
    default:
      return 'perform this action'
  }
}
