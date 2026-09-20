import type { Post } from '@/lib/types'
import { createModalStore } from '@/lib/modal-store'

interface ModeratorRemovePayload {
  post: Post | null
  /** Runs after the removal landed, so the card can drop itself. */
  onRemoved: (() => void) | null
}

/** The reason dialog shown before a moderator removes a post or reply. */
export const useModeratorRemoveModal = createModalStore<
  ModeratorRemovePayload,
  [post: Post, onRemoved: () => void]
>({ post: null, onRemoved: null }, (post, onRemoved) => ({ post, onRemoved }))
