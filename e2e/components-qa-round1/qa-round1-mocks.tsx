// Offline boundaries only. The changed pages/components render their real JSX and run their real event handlers.
import type { ReactNode } from 'react'
import { useState } from 'react'
import { ThreadView } from '@/components/messages/thread-view'
import type { InboxRow } from '@/components/messages/conversation-list'
import type { Post, Store, StoreItem } from '@/lib/types'
import { variantsFromRows } from '@/lib/storefront/variant-codec'
const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture')
const noop = () => undefined
const router = { push: noop, back: noop, replace: noop }
export const useRouter = () => router
export const usePathname = () => '/messages'
export const useSearchParams = () => new URLSearchParams(fixture === 'profile-page' ? 'id=11111111111111111111111111111111' : 'id=store&storeId=store')
export const useAuth = () => ({ user: { identityId: fixture === 'checkout' ? 'buyer' : 'owner' } })
export const withAuth = <T,>(component: T) => component
export const useSdk = () => ({ isReady: true })
export const PageShell = ({ children }: { children: ReactNode }) => <main>{children}</main>
export const PageHeader = ({ children }: { children: ReactNode }) => <header>{children}</header>
export const Sidebar = () => null
export const RightSidebar = () => null
export const PrivateFeedAccessButton = () => null
export const UsernameDropdown = () => null
export const ContractReportButton = () => null
export const ModeratorContentMenu = () => null
export const PaymentQRCode = () => null
export const PostTips = () => null
export const PostCard = () => <div>Post content</div>
export const ReplyThreadItem = () => <div>Existing reply</div>
export const flattenReplyThreads = () => []
export const row: InboxRow = { key: 'group', kind: 'group', peerId: 'owner', name: 'DM QA friends — café ☕', memberIds: ['owner', 'peer'], preview: null, previewOwn: false, lastActivity: 0, unread: 0, hidden: false, legacyOnly: false, notice: null }
export const details = new Map([['owner', { id: 'owner', displayName: 'Owner', hasDpns: false }], ['peer', { id: 'peer', displayName: 'Jakub Rahman', hasDpns: false }]])
export function MessagesV5() {
  return <ThreadView row={row} details={details} messages={[]} status={{ blockedReason: null, banner: null }} isLoading={false} blocked={false} onBack={noop} onSend={async () => undefined} onOpenGroupSettings={noop} onToggleBlock={noop} onHide={noop} />
}
export function LegacyMessages() { return <MessagesV5 /> }
export const useInfiniteScroll = () => ({ sentinelRef: { current: null }, isSuspended: false, loadMore: noop })
const deleted = params.get('state') !== 'live'
const post = { id: 'post', author: { id: 'owner', displayName: 'Owner' }, content: '', createdAt: new Date(0), deleted }
export const usePostDetail = () => {
  const failure = params.get('failure')
  const [error, setError] = useState(failure ? 'transport error: Failed to fetch' : null)
  const [isLoadingReplies, setIsLoadingReplies] = useState(false)
  return {
    post: failure === 'post' && error ? null : post,
    replyThreads: failure === 'refresh' ? [{ content: { id: 'existing-reply' } }] : [],
    replyChain: [], removedChainIds: [], replyRootPending: false, isLoading: false,
    isLoadingReplies, hasMoreReplies: false, isLoadingMoreReplies: false,
    loadMoreReplies: async () => undefined, error,
    refresh: async () => {
      setError(null)
      setIsLoadingReplies(true)
      await new Promise(resolve => setTimeout(resolve, 100))
      setIsLoadingReplies(false)
    },
  }
}
const enrichment = { enrichProgressively: noop, getPostEnrichment: noop, reset: noop }
export const useProgressiveEnrichment = () => enrichment
export const useCanReplyToPrivate = () => ({ canReply: true, isLoading: false })
export const privateFeedService = {
  getOverview: async () => ({ feed: { feed: 1, treeCapacity: 4096, maxKeyGeneration: 4095 }, followers: [], keyGeneration: 2 }),
  getPendingRequests: async () => [], hasPrivateFeed: async () => false,
}
export const fetchRekeys = async () => [{ keyGeneration: 2, revokedLeaf: 0, createdAt: Date.now() }]
let postReads = 0
let replyReads = 0
let nestedReads = 0
let proofReads = 0
const nestedRefresh = params.get('failure') === 'nested-refresh'
const proofRefresh = params.get('failure') === 'proof-refresh'
const proofPagination = params.get('failure') === 'proof-pagination'
const proofInitial = params.get('failure') === 'proof-initial'
const focusedReply = { ...post, rootPostId: 'root', parentId: 'root' }
const existingReply = { ...post, id: 'existing-reply', content: 'Existing reply', rootPostId: nestedRefresh ? 'root' : 'post', parentId: 'post', createdAt: new Date(1), ...(nestedRefresh ? { replyToReplyId: 'post' } : {}) }
export const postService = {
  getUserPosts: async () => ({ documents: [] }),
  getOrThrow: async (id: string) => {
    postReads++
    if (params.get('failure') === 'post' && postReads === 1) throw new Error('DAPI unavailable')
    if (nestedRefresh && id === 'post') return null
    return { ...post, id }
  },
}
export const replyService = {
  getOrThrow: async () => focusedReply,
  getReplies: async () => {
    replyReads++
    if (params.get('failure') === 'replies' && replyReads === 1 || params.get('failure') === 'refresh' && replyReads === 2) {
      throw new Error('DAPI unavailable')
    }
    if (proofPagination) return replyReads === 1
      ? { documents: [existingReply], nextCursor: 'first-page' }
      : { documents: [{ ...existingReply, id: 'new-reply', content: 'New reply', replyToReplyId: 'missing-parent' }] }
    if (proofInitial) return { documents: [{ ...existingReply, replyToReplyId: 'missing-parent' }], nextCursor: 'first-page' }
    return nestedRefresh ? { documents: [focusedReply], nextCursor: 'first-page' } : { documents: [{ ...existingReply, ...(proofRefresh ? { replyToReplyId: 'missing-parent' } : {}) }] }
  },
  getNestedReplies: async (parentIds: string[], options: { throwOnError?: boolean }) => {
    if (!parentIds.includes('post')) return new Map(parentIds.map(id => [id, []]))
    nestedReads++
    if (nestedReads === 2) {
      if (options.throwOnError) throw new Error('DAPI unavailable')
      return new Map([['post', []]])
    }
    return new Map([['post', [existingReply]]])
  },
}
export const provenAbsent = async (_kind: string, ids: string[], options: { throwOnError?: boolean } = {}) => {
  proofReads++
  if (proofReads === (proofPagination || proofInitial ? 1 : 2)) {
    if (options.throwOnError) throw new Error('DAPI unavailable')
    return new Set<string>()
  }
  return new Set(ids)
}
const postEnrichment = { enrich: async (posts: Post[]) => posts, reset: noop }
export const usePostEnrichment = () => postEnrichment
export const resolveUserDetailsBatch = async () => new Map()
export const replyToPost = (reply: typeof focusedReply) => ({ ...reply, targetKind: 'reply' as const })
export const identityService = { hasEncryptionKey: async () => true, getIdentity: async () => ({ publicKeys: [] }) }
export const resolveEncryptionPublicKey = async () => Uint8Array.from([2, ...new Array<number>(32).fill(1)])
export const store: Store = { id: 'store', ownerId: 'owner', name: 'QA store', status: 'active', description: '', defaultCurrency: 'USD', createdAt: new Date(0), paymentUris: [{ uri: 'bitcoin:mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', scheme: 'bitcoin:', label: 'Bitcoin' }] }
export const eurItem: StoreItem = { id: 'eur', ownerId: 'owner', storeId: 'store', title: 'Euro variants', status: 'active', createdAt: new Date(0), currency: 'EUR', variants: variantsFromRows(['Size'], [{ optionNames: ['S'], price: 325 }, { optionNames: ['L'], price: 475 }]).variants ?? undefined }
const digitalItem: StoreItem = { id: 'digital', ownerId: 'owner', storeId: 'store', title: 'Download', status: params.get('state') === 'archived' ? 'deleted' : 'active', createdAt: new Date(0), currency: 'USD', fulfillment: 'digital', basePrice: 200 }
export const storeService = { getById: async () => store, getCurrent: async () => store, getByOwner: async () => store }
export const storeItemService = {
  getAllByStore: async () => [], getByStore: async () => ({ items: fixture === 'export' ? (params.get('state') === 'digital-only' ? [digitalItem] : [eurItem, digitalItem]) : [] }),
  getStock: (item: StoreItem) => item.stockQuantity ?? Infinity,
  getPriceRange: (item: StoreItem) => { const prices = item.variants?.combinations.map(c => c.price) ?? [item.basePrice ?? 0]; return { min: Math.min(...prices), max: Math.max(...prices) } },
}
export const shippingZoneService = { getByStore: async () => [{ id: 'zone', name: 'QA US', rateType: 'flat', flatRate: 500, currency: 'USD' }] }
export const checkShipping = noop
export const finalShippingCheck = noop
export const SHIPPING_CHECK_FAILED_MESSAGE = 'Shipping failed'
export const SHIPPING_UNAVAILABLE_MESSAGE = 'Shipping unavailable'
export const storeStatsService = { countSellerOrders: async () => 0, getStoreRatingSummary: async () => ({ averageRating: 4, reviewCount: Number(params.get('count') ?? 1) }), topItemsInStore: async () => [], getItemReviewCounts: async () => new Map() }
export const storeReviewService = { getStoreReviews: async () => ({ reviews: [] }) }
export const storeOrderService = { getSellerOrders: async () => ({ orders: [] }), buildOrderPayload: () => ({ items: [], paymentUri: '', subtotal: 200, shippingCost: 0, total: 200, currency: 'USD', buyerContact: {} }) }
export const unifiedProfileService = { getProfile: async () => null }
export const dpnsService = { resolveUsername: async () => null, getAllUsernamesSorted: async () => [] }
const cartItem = { itemId: 'product', storeId: 'store', title: 'Digital item', fulfillment: 'digital', quantity: 1, unitPrice: 200, currency: 'USD' }
export const cartService = { subscribe: () => noop, getItemCount: () => 0, getItemsForStore: () => [cartItem], getAvailability: async () => [{ item: cartItem, reason: null }] }
export const getCartCurrency = () => 'USD'
export const savedAddressService = { getUserEncryptionPublicKey: async () => null, getDecryptedAddresses: async () => [], getDefaultAddress: () => null }

export const reportModerationRefusal = () => false
export const reportBarredWrite = () => false
export const useUserSearch = () => ({ results: [], loading: false })
export const cartLineKey = (item: { itemId: string }) => item.itemId
export const followService = { isFollowing: async () => false }
export const APPROVED_PAYMENT_SCHEMES = ['bitcoin:', 'tdash:']
export const formatCreditsAsDash = () => '0'
export const isBoundToContract = () => false
export const findEncryptionKey = () => null

export const loadUserStats = async () => ({ posts: Number(params.get('count') ?? 1), followers: 0, following: 0 })
export const useProfileTabs = () => ({ activeTab: 'posts', setActiveTab: noop, replies: {}, top: {}, mentions: {} })
export const useBlockProvenance = () => ({ isBlocked: false, isOwnBlock: false, isLoading: false, unblock: noop })
export const useModeratedTypeOpen = () => true
export const ProfileTabs = () => null
export const YappFlow = () => null
export const UsernameModal = () => null
export const PaymentQRCodeDialog = () => null
export const AvatarCustomization = () => null
export const BannerCustomization = () => null
export const paymentUriScheme = () => ''
export const blogService = { getBlogsByOwner: async () => [] }
export const blogPostService = { getPostsByBlogs: async () => new Map() }
export const privateFeedFollowerService = {}
