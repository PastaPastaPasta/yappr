import type { Post } from '@/lib/types'
import { createModalStore } from '@/lib/modal-store'

interface DeleteConfirmationPayload {
  post: Post | null
  onConfirm: (() => Promise<void>) | null
  isDeleting: boolean
}

/** The confirmation dialog shown before a post is deleted. */
export const useDeleteConfirmationModal = createModalStore<
  DeleteConfirmationPayload,
  [post: Post, onConfirm: () => Promise<void>],
  { setDeleting: (deleting: boolean) => void }
>(
  { post: null, onConfirm: null, isDeleting: false },
  (post, onConfirm) => ({ post, onConfirm }),
  (set) => ({ setDeleting: (isDeleting) => set({ isDeleting }) })
)
