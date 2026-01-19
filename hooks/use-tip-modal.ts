import { create } from 'zustand'
import { Post } from '@/lib/types'

// Recipient data for user-only tipping (when no post is involved)
export interface TipRecipient {
  id: string
  displayName?: string
  username?: string
}

interface TipModalStore {
  isOpen: boolean
  post: Post | null
  recipient: TipRecipient | null  // For user-only tipping
  open: (post: Post) => void
  openForUser: (recipient: TipRecipient) => void  // Open modal to tip a user directly
  close: () => void
}

export const useTipModal = create<TipModalStore>((set) => ({
  isOpen: false,
  post: null,
  recipient: null,
  open: (post) => set({ isOpen: true, post, recipient: null }),
  openForUser: (recipient) => set({ isOpen: true, post: null, recipient }),
  close: () => set({ isOpen: false, post: null, recipient: null }),
}))
