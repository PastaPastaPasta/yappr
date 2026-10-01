import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import {
  likeIndexFor, ownQuoteIndexFor, repostIndexFor, repostsAreQuotes, type OwnedTargetIndex, type TargetKind,
} from '@/lib/contract-topology'
import { queryRawDocuments } from '@/lib/services/document-service'
import { identifierToBase58, type DocumentOrderByClause, type DocumentWhereClause } from '@/lib/services/sdk-helpers'

/**
 * Reads for "check again" that THROW when the query fails. lib's own lookups
 * for these relations (`getLike`, `getRepost`, `getOwnQuotes`, `getBlock`)
 * answer a failed read as "none", and its block status also answers from a
 * cache its own write fills on an unconfirmed broadcast, so neither can prove
 * a write landed or not. These query the same unique (owner, target) indexes
 * lib's lookups use, with the same clause order.
 */

/** The block doctype's `ownerAndBlocked [$ownerId, blockedId]` index (block-service `getOwnBlockedIds`). */
const BLOCK_INDEX: OwnedTargetIndex = { docType: 'block', field: 'blockedId', ownerFirst: true, ownerField: null }

/** The owner's document naming `targetId` on `index` (like-service `queryLike`'s clause order), or null. */
async function ownedDocument(index: OwnedTargetIndex, ownerId: string, targetId: string): Promise<Record<string, unknown> | null> {
  const target: DocumentWhereClause = [index.field, '==', targetId]
  const owner: DocumentWhereClause = ['$ownerId', '==', ownerId]
  const where = index.ownerFirst ? [owner, target] : [target, owner]
  const documents = await queryRawDocuments({
    dataContractId: YAPPR_CONTRACT_ID,
    documentTypeName: index.docType,
    where,
    // v10's indexOnly likes pin owner and target with equalities alone (like-service).
    ...(index.ownerIsTerminal ? {} : { orderBy: where.map(([property]): DocumentOrderByClause => [property, 'asc']) }),
    limit: 1,
  })
  return documents[0] ?? null
}

export async function likeExists(ownerId: string, targetId: string, kind: TargetKind): Promise<boolean> {
  return (await ownedDocument(likeIndexFor(kind), ownerId, targetId)) !== null
}

/**
 * The viewer's quote or bare repost of a target (v10's one slot), `bare`
 * as `isQuoteOnly` decides: no text, ciphertext, media or embed of its own.
 */
export async function ownQuoteStrict(ownerId: string, targetId: string, kind: TargetKind): Promise<{ id: string; bare: boolean } | null> {
  const index = ownQuoteIndexFor(kind)
  if (!index) return null
  const doc = await ownedDocument(index, ownerId, targetId)
  const id = doc && identifierToBase58(doc.$id ?? doc.id)
  if (!doc || !id) return null
  const content = typeof doc.content === 'string' ? doc.content : ''
  return { id, bare: !content.trim() && !doc.encryptedContent && !doc.mediaUrl && !doc.embedId }
}

/** The viewer's repost of a target: a `repost` document, or on v10 a bare quote post. */
export async function repostExists(ownerId: string, targetId: string, kind: TargetKind): Promise<boolean> {
  if (repostsAreQuotes()) return (await ownQuoteStrict(ownerId, targetId, kind))?.bare === true
  const index = repostIndexFor(kind)
  return index !== null && (await ownedDocument(index, ownerId, targetId)) !== null
}

/** The viewer's own block document on an account (never the cache, never a followed list). */
export async function ownBlockExists(ownerId: string, blockedId: string): Promise<boolean> {
  return (await ownedDocument(BLOCK_INDEX, ownerId, blockedId)) !== null
}
