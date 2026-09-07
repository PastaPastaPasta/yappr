'use client'

import { create } from 'zustand'
import { Post } from '@/lib/types'

interface EditPostModalStore {
  isOpen: boolean
  post: Post | null
  open: (post: Post) => void
  close: () => void
}

/**
 * Global store for the edit post modal.
 * Use this to let users edit the content of their own posts and replies.
 */
export const useEditPostModal = create<EditPostModalStore>((set) => ({
  isOpen: false,
  post: null,
  open: (post) => set({ isOpen: true, post }),
  close: () => set({ isOpen: false, post: null }),
}))
