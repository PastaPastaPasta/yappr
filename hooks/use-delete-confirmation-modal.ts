'use client'

import { create } from 'zustand'
import { Post } from '@/lib/types'

interface DeleteConfirmationModalStore {
  isOpen: boolean
  post: Post | null
  isDeleting: boolean
  onConfirm: (() => Promise<void>) | null
  open: (post: Post, onConfirm: () => Promise<void>) => void
  close: () => void
  setDeleting: (deleting: boolean) => void
}

/**
 * Global store for the delete confirmation modal.
 * Use this to show a confirmation dialog before deleting a post.
 */
export const useDeleteConfirmationModal = create<DeleteConfirmationModalStore>((set) => ({
  isOpen: false,
  post: null,
  isDeleting: false,
  onConfirm: null,
  open: (post, onConfirm) => set({ isOpen: true, post, onConfirm, isDeleting: false }),
  close: () => set({ isOpen: false, post: null, onConfirm: null, isDeleting: false }),
  setDeleting: (deleting) => set({ isDeleting: deleting }),
}))
