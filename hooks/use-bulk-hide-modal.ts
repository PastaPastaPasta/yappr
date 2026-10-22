import { createModalStore } from '@/lib/modal-store'

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

/** The dialog that hides many of one account's posts and replies at once (components/moderation/bulk-hide-modal.tsx). */
export const useBulkHideModal = createModalStore<BulkHidePayload, [target: BulkHideTarget]>(
  { target: null },
  (target) => ({ target })
)
