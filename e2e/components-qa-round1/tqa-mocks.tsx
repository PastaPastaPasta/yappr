export * from './qa-round1-mocks'
export { UsernameModal } from '../../components/dpns/username-modal'
export { usePostDetail } from '../../hooks/use-post-detail'
import { dpnsService as actualDpns } from '../../lib/services/dpns-service'
import { eurItem, storeItemService as items, useSearchParams as baseSearchParams } from './qa-round1-mocks'
import type { Post, Reply, ReplyThread } from '@/lib/types'
import { hasFlatThreads } from '@/lib/contract-topology'
const params = new URLSearchParams(window.location.search)
const scenario = params.get('scenario')
export const dpnsService = {
  getUsernameValidationError: (label: string) => actualDpns.getUsernameValidationError(label),
  batchCheckAvailability: async (labels: string[]) => new Map(labels.map(label => [label.toLowerCase(), { available: true, contested: false }])),
}
export const storeItemService = { ...items, get: async () => ({ ...eurItem, variants: undefined, stockQuantity: 42 }), hasInventoryTracking: () => true, getAllByStore: async () => [eurItem], getByStore: async () => ({ items: [eurItem] }) }
export const rootPost: Post = { id: 'root', author: { id: 'author', username: 'author', displayName: 'Author', avatar: '', joinedAt: new Date(0), followers: 0, following: 0 }, content: 'Root', createdAt: new Date(1), likes: 0, replies: 1, reposts: 0, quotes: 0, views: 0 }
export const continuation: Reply = { ...rootPost, id: 'continuation', parentId: 'root', parentOwnerId: 'author', rootPostId: hasFlatThreads() ? 'root' : undefined, content: 'Continuation', author: scenario === 'v2-descendant' ? { ...rootPost.author, id: 'other' } : rootPost.author }
const descendant: Reply = { ...continuation, id: 'descendant', parentId: 'continuation', content: 'Rendered nested child', author: { ...rootPost.author, id: 'child-author' } }
export const acceptedReply: Reply = { ...continuation, id: 'accepted', author: { ...rootPost.author, id: 'reader' }, parentId: scenario === 'v2-descendant' ? 'descendant' : 'continuation', replyToReplyId: hasFlatThreads() ? 'continuation' : undefined, content: 'Accepted nested reply', createdAt: new Date(2) }
let published = false
let reads = 0
let confirmations = 0
let bookmarkReads = 0
let replyBookmarkReads = 0
let postReads = 0
let release: (() => void) | undefined
let held = false
let ancestorChanged = false
let changedAncestorReads = 0
let changedAncestorProofs = 0
export function changeAncestor() { ancestorChanged = true }
export function finishThreadRead() { release?.() }
export const useSearchParams = () => params.get('fixture') === 'thread-page' ? new URLSearchParams('id=root') : baseSearchParams()
export function ReplyThreadItem({ thread }: { thread: ReplyThread }) {
  return <article data-reply-id={thread.content.id} data-deleted={thread.content.deleted} data-deleted-stub={thread.content.deletedStub}>{thread.content.content}{thread.nestedReplies.map(child => <ReplyThreadItem key={child.content.id} thread={child} />)}</article>
}
export function publishReply() {
  published = true
  window.dispatchEvent(new CustomEvent('reply-created', { detail: { reply: acceptedReply } }))
}
export function threadReads() { return reads }
export const postService = {
  getPostById: async () => rootPost,
  getOrThrow: async () => {
    postReads++
    if (published && scenario === 'post-outage' && postReads === 2) throw new TypeError('Failed to fetch')
    return rootPost
  },
  getPostsByIdsForDisplay: async (_ids: string[], options?: { throwOnError?: boolean }) => {
    bookmarkReads++
    if (!options?.throwOnError) throw new Error('Bookmark reads must distinguish absence from failure')
    if (scenario === 'bookmark-outage' && bookmarkReads === 1) throw new TypeError('Failed to fetch')
    if (scenario?.startsWith('reply-bookmark')) return { posts: [], preloaded: {} }
    if (!hasFlatThreads() && scenario !== 'bookmark-outage') return { posts: [], preloaded: {} }
    return { posts: [{ ...rootPost, deleted: scenario !== 'bookmark-outage' }], preloaded: {} }
  },
  enrichPostsBatch: async (posts: Post[]) => posts,
}
export const replyToPost = (reply: Reply) => ({ ...reply, targetKind: 'reply' as const, quotes: 0 })
export const PostCard = ({ post }: { post: Post }) => <article data-target-kind={post.targetKind}>{post.content}<span>Post content</span></article>
export const replyService = {
  getReplies: async () => {
    reads++
    if (published && scenario === 'slow' && !held) {
      held = true
      await new Promise<void>(resolve => { release = resolve })
    }
    if (published && scenario !== 'slow' && scenario !== 'post-outage' && !scenario?.startsWith('ancestor-') && (scenario === 'outage' || reads === 2)) throw new TypeError('Failed to fetch')
    const beyondPage = scenario === 'paged' || scenario === 'indexing'
    // After a failed proof the next page can omit the child too: its saved
    // overlay must survive the failed attempt, not just its rendered state.
    if (published && scenario === 'ancestor-proof-outage' && changedAncestorProofs > 0) return { documents: [], nextCursor: 'page2' }
    if (published && (scenario === 'child-page' || scenario?.startsWith('ancestor-'))) return { documents: [acceptedReply], nextCursor: 'page2' }
    if (published && scenario === 'paged') return { documents: [], nextCursor: 'page2' }
    return { documents: published && !beyondPage && hasFlatThreads() ? [continuation, acceptedReply] : [continuation], nextCursor: beyondPage ? 'page2' : undefined }
  },
  getReplyById: async () => null,
  getOrThrow: async () => null,
  query: async ({ where }: { where: [string, string, string[]][] }) => {
    if (ancestorChanged && scenario === 'ancestor-outage' && ++changedAncestorReads === 1) throw new TypeError('Failed to fetch')
    const ids = where[0][2]
    const documents = [continuation, descendant].filter(reply => ids.includes(reply.id))
    if (!ancestorChanged) return { documents }
    return { documents: scenario === 'ancestor-removed' || scenario === 'ancestor-proof-outage' ? [] : documents.map(reply => ({ ...reply, deleted: true, content: '' })) }
  },
  getMany: async (ids: string[], options?: { throwOnError?: boolean }) => {
    if (scenario?.startsWith('reply-bookmark')) {
      replyBookmarkReads++
      if (!options?.throwOnError || ids.length !== 1 || ids[0] !== continuation.id) throw new Error('Reply bookmark hydration must strictly read missing targets')
      if (scenario === 'reply-bookmark-outage' && replyBookmarkReads === 1) throw new TypeError('Failed to fetch')
      return scenario === 'reply-bookmark-deleted' ? [] : [continuation]
    }
    confirmations++
    return published && (scenario !== 'indexing' || confirmations >= 2) ? [acceptedReply] : []
  },
  getNestedReplies: async (parentIds: string[]) => new Map(parentIds.map(id => [id,
    scenario === 'v2-descendant' ? (id === 'continuation' ? [descendant] : published && id === 'descendant' ? [acceptedReply] : [])
      : published && scenario !== 'paged' && scenario !== 'indexing' && id === 'continuation' ? [acceptedReply] : [],
  ])),
}
const enrichment = { enrich: async (posts: Post[]) => posts, reset: () => undefined }
export const usePostEnrichment = () => enrichment
export const attachQuotedPosts = async () => undefined
export const provenAbsent = async (_kind: string, ids: string[]) => {
  if (ancestorChanged && scenario === 'ancestor-proof-outage' && ++changedAncestorProofs === 1) throw new TypeError('Failed to fetch')
  return new Set(ancestorChanged && (scenario === 'ancestor-removed' || scenario === 'ancestor-proof-outage') ? ids : [])
}
let bookmarkDeleted = false
export const bookmarkService = {
  getUserBookmarks: async () => bookmarkDeleted ? [] : [{ $id: 'bookmark', $ownerId: 'owner', $createdAt: 1, postId: scenario?.startsWith('reply-bookmark') ? continuation.id : 'root' }],
  removeBookmark: async () => { bookmarkDeleted = true; return true },
}

const auth = { user: { identityId: 'owner' } }
export const useAuth = () => auth

export const useBlogFollow = () => ({ isFollowing: false, isLoading: false, toggleFollow: async () => undefined })
export const BlogComments = () => null
export const itemReviewService = { getItemReviews: async () => ({ reviews: [] }) }
export const cartService = { getItemCount: () => 0, subscribe: () => () => undefined, quantityInCart: () => 0, lineIdentity: () => 'line' }
