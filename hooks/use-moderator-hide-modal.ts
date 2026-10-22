import type { Post } from '@/lib/types'
import { targetKindOf } from '@/lib/contract-topology'
import { createModalStore } from '@/lib/modal-store'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import type { ModerationMarks } from '@/lib/moderation-view'

/** What a moderator does on a "hide, don't delete" cut (social v18, blog v10, storefront v11). */
export type ModeratorHideAction = 'hide' | 'unhide' | 'restrict' | 'lift'

/** The item (or account) a hide, unhide, restriction or lift is about. */
export interface ModeratorHideTarget {
  action: ModeratorHideAction
  contract: ModeratedContractKey
  /** The document type and id (`post`, `storeReview`, …); for a restriction, the item it was opened from, if any. */
  docType?: string
  documentId?: string
  /** The author: who a restriction is placed on or lifted from. */
  authorId: string
  /** How the dialog names the item ("post", "listing", "review", …). */
  noun: string
  /** What the moderator sees of the item before acting. */
  preview?: string
}

/** What the view shows once the action landed: the item's new marks (null once unhidden), or the author's new standing. */
export interface ModeratorHideOutcome {
  moderation?: ModerationMarks | null
  restricted?: boolean
  /** The network did not confirm it in time: it may not have landed, so the next read is the truth. */
  unconfirmed?: boolean
}

interface ModeratorHidePayload {
  target: ModeratorHideTarget | null
  onDone: ((outcome: ModeratorHideOutcome) => void) | null
}

/** A social post or reply as the target of `action`. */
export function postHideTarget(post: Post, action: ModeratorHideAction): ModeratorHideTarget {
  const kind = targetKindOf(post)
  return { action, contract: 'social', docType: kind, documentId: post.id, authorId: post.author.id, noun: kind === 'reply' ? 'reply' : 'post', preview: post.content }
}

/** The dialog a moderator hides, unhides, restricts or lifts from. */
export const useModeratorHideModal = createModalStore<
  ModeratorHidePayload,
  [target: ModeratorHideTarget, onDone?: (outcome: ModeratorHideOutcome) => void]
>({ target: null, onDone: null }, (target, onDone) => ({ target, onDone: onDone ?? null }))
