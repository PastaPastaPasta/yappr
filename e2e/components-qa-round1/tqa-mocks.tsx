export * from './qa-round1-mocks'
export { UsernameModal } from '../../components/dpns/username-modal'
export { usePostDetail } from '../../hooks/use-post-detail'
import { dpnsService as actualDpns } from '../../lib/services/dpns-service'
import { eurItem, storeItemService as items } from './qa-round1-mocks'
import type { Post, Reply } from '@/lib/types'
import { hasFlatThreads } from '@/lib/contract-topology'
const params = new URLSearchParams(window.location.search)
const scenario = params.get('scenario')
export const dpnsService = {
  getUsernameValidationError: (label: string) => actualDpns.getUsernameValidationError(label),
  batchCheckAvailability: async (labels: string[]) => new Map(labels.map(label => [label.toLowerCase(), { available: true, contested: false }])),
}
export const storeItemService = { ...items, get: async () => ({ ...eurItem, variants: undefined, stockQuantity: 42 }), hasInventoryTracking: () => true, getAllByStore: async () => [eurItem], getByStore: async () => ({ items: [eurItem] }) }
export const rootPost: Post = { id: 'root', author: { id: 'author', username: 'author', displayName: 'Author', avatar: '', joinedAt: new Date(0), followers: 0, following: 0 }, content: 'Root', createdAt: new Date(1), likes: 0, replies: 1, reposts: 0, quotes: 0, views: 0 }
export const continuation: Reply = { ...rootPost, id: 'continuation', parentId: 'root', parentOwnerId: 'author', rootPostId: hasFlatThreads() ? 'root' : undefined, content: 'Continuation' }
export const acceptedReply: Reply = { ...continuation, id: 'accepted', author: { ...rootPost.author, id: 'reader' }, parentId: 'continuation', replyToReplyId: hasFlatThreads() ? 'continuation' : undefined, content: 'Accepted nested reply', createdAt: new Date(2) }
let published = false
let reads = 0
let confirmations = 0
let bookmarkReads = 0
export function publishReply() {
  published = true
  window.dispatchEvent(new CustomEvent('reply-created', { detail: { reply: acceptedReply } }))
}
export function threadReads() { return reads }
export const postService = {
  getPostById: async () => rootPost,
  getPostsByIdsForDisplay: async (_ids: string[], options?: { throwOnError?: boolean }) => {
    bookmarkReads++
    if (!options?.throwOnError) throw new Error('Bookmark reads must distinguish absence from failure')
    if (scenario === 'bookmark-outage' && bookmarkReads === 1) throw new TypeError('Failed to fetch')
    return { posts: [{ ...rootPost, deleted: scenario !== 'bookmark-outage' }], preloaded: {} }
  },
  enrichPostsBatch: async (posts: Post[]) => posts,
}
export const replyToPost = (reply: Reply) => ({ ...reply, quotes: 0 })
export const replyService = {
  getReplies: async () => {
    reads++
    if (published && (scenario === 'outage' || reads === 2)) throw new TypeError('Failed to fetch')
    const beyondPage = scenario === 'paged' || scenario === 'indexing'
    if (published && scenario === 'paged') return { documents: [], nextCursor: 'page2' }
    return { documents: published && !beyondPage && hasFlatThreads() ? [continuation, acceptedReply] : [continuation], nextCursor: beyondPage ? 'page2' : undefined }
  },
  getReplyById: async () => null,
  getMany: async () => {
    confirmations++
    return published && (scenario !== 'indexing' || confirmations >= 2) ? [acceptedReply] : []
  },
  getNestedReplies: async (parentIds: string[]) => new Map(parentIds.map(id => [id, published && scenario !== 'paged' && scenario !== 'indexing' && id === 'continuation' ? [acceptedReply] : []])),
}
const enrichment = { enrich: async (posts: Post[]) => posts, reset: () => undefined }
export const usePostEnrichment = () => enrichment
export const attachQuotedPosts = async () => undefined
let bookmarkDeleted = false
export const bookmarkService = {
  getUserBookmarks: async () => bookmarkDeleted ? [] : [{ $id: 'bookmark', $ownerId: 'owner', $createdAt: 1, postId: 'root' }],
  removeBookmark: async () => { bookmarkDeleted = true; return true },
}

const auth = { user: { identityId: 'owner' } }
export const useAuth = () => auth

export const useBlogFollow = () => ({ isFollowing: false, isLoading: false, toggleFollow: async () => undefined })
export const BlogComments = () => null
export const itemReviewService = { getItemReviews: async () => ({ reviews: [] }) }
export const cartService = { getItemCount: () => 0, subscribe: () => () => undefined, quantityInCart: () => 0, lineIdentity: () => 'line' }
