import type { Post } from '@/lib/types'
import { targetKindOf } from '@/lib/contract-topology'
import { createModalStore } from '@/lib/modal-store'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'

/** One document a moderator may take down, on any of Yappr's moderated contracts. */
export interface ModeratorRemoveTarget {
  contract: ModeratedContractKey
  /** The document type, as the contract names it (`post`, `storeReview`, `blogComment`, …). */
  docType: string
  documentId: string
  /** When it was last written (ms); NaN when unknown. Decides whether it has settled past its deletion window. */
  createdAt: number
  /** What the moderator sees of it before removing it. */
  preview: string
  /** How the dialog names it ("post", "listing", "review", "comment", …). */
  noun: string
}

interface ModeratorRemovePayload {
  target: ModeratorRemoveTarget | null
  /** Runs after the removal landed, so the view can drop the document. */
  onRemoved: (() => void) | null
}

/** Any moderated document as a removal target. */
export function documentRemovalTarget(
  contract: ModeratedContractKey,
  docType: string,
  noun: string,
  doc: { id: string; createdAt?: Date | string | number | null; updatedAt?: Date | string | number | null },
  preview: string
): ModeratorRemoveTarget {
  const windowStart = doc.updatedAt ?? doc.createdAt
  return {
    contract,
    docType,
    documentId: doc.id,
    createdAt: windowStart != null ? new Date(windowStart).getTime() : Number.NaN,
    preview,
    noun,
  }
}

/** A social post or reply as a removal target. */
export function postRemovalTarget(post: Post): ModeratorRemoveTarget {
  const kind = targetKindOf(post)
  return documentRemovalTarget('social', kind, kind === 'reply' ? 'reply' : 'post', post, post.content)
}

/** The reason dialog shown before a moderator removes a document. */
export const useModeratorRemoveModal = createModalStore<
  ModeratorRemovePayload,
  [target: ModeratorRemoveTarget, onRemoved: () => void]
>({ target: null, onRemoved: null }, (target, onRemoved) => ({ target, onRemoved }))
