import type { Post } from '@/lib/types'
import { createModalStore } from '@/lib/modal-store'

/** Who receives a tip when no post is involved. */
export interface TipRecipient {
  id: string
  displayName?: string
  username?: string
}

interface TipPayload {
  post: Post | null
  recipient: TipRecipient | null
}

const closed: TipPayload = { post: null, recipient: null }

export const useTipModal = createModalStore<TipPayload, [post: Post], { openForUser: (recipient: TipRecipient) => void }>(
  closed,
  (post) => ({ post }),
  (set) => ({
    /** Tip a user directly rather than through one of their posts. */
    openForUser: (recipient) => set({ ...closed, recipient, isOpen: true }),
  })
)
