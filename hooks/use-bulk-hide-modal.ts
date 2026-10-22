import { create } from 'zustand'
import { createModalStore } from '@/lib/modal-store'
import type { PostModeration } from '@/lib/types'

/** The account whose posts a moderator hides (or unhides) in bulk, and the reason to start from. */
export interface BulkHideTarget {
  authorId: string
  /** How the dialog names the account ("@alice"); "this account" when absent. */
  authorName?: string
  /** The reason (its label) and note to start from: the restriction's, when opened from the Restrict dialog. */
  label?: number
  note?: string
}

interface BulkHidePayload {
  target: BulkHideTarget | null
}

interface BulkModeratedMarks {
  /** By document id: the marks a bulk run gave it this session (null once unhidden). */
  marks: Record<string, PostModeration | null>
  record: (documentId: string, marks: PostModeration | null) => void
}

/**
 * What the bulk dialog changed, for the post cards already on screen behind
 * it: their reads still hold the old marks, so a card shows these until it
 * sets its own (lib/moderation-bulk.ts counts each one only once it is proved).
 */
export const useBulkModeratedMarks = create<BulkModeratedMarks>((set) => ({
  marks: {},
  record: (documentId, marks) => set((state) => ({ marks: { ...state.marks, [documentId]: marks } })),
}))

/** The dialog that hides many of one account's posts and replies at once (components/moderation/bulk-hide-modal.tsx). */
export const useBulkHideModal = createModalStore<BulkHidePayload, [target: BulkHideTarget]>(
  { target: null },
  (target) => ({ target })
)
