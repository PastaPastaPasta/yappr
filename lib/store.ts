import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User, Post, FeedItem, isFeedReplyContext } from './types'
import { mockCurrentUser } from './mock-data'
import { ProgressiveEnrichment } from '@/components/post/post-card'

export interface ThreadPost {
  id: string
  content: string
  postedPostId?: string // Platform post ID if successfully posted
}

// Pending navigation data for instant feed -> post detail transitions
// This is NOT a cache - it's set at navigation time and consumed immediately
export interface PendingPostNavigation {
  post: Post
  enrichment?: ProgressiveEnrichment
}

interface AppState {
  currentUser: User | null
  isComposeOpen: boolean
  replyingTo: Post | null
  quotingPost: Post | null
  // Thread composition state
  threadPosts: ThreadPost[]
  activeThreadPostId: string | null
  // Pending navigation data (set when clicking post, consumed on detail page mount)
  pendingPostNavigation: PendingPostNavigation | null

  setCurrentUser: (user: User | null) => void
  setComposeOpen: (open: boolean) => void
  setReplyingTo: (post: Post | null) => void
  setQuotingPost: (post: Post | null) => void
  // Thread composition actions
  addThreadPost: () => void
  removeThreadPost: (id: string) => void
  updateThreadPost: (id: string, content: string) => void
  markThreadPostAsPosted: (id: string, postedPostId: string) => void
  setActiveThreadPost: (id: string | null) => void
  resetThreadPosts: () => void
  // Navigation actions for instant post detail transitions
  setPendingPostNavigation: (post: Post, enrichment?: ProgressiveEnrichment) => void
  consumePendingPostNavigation: (postId: string) => PendingPostNavigation | null
}

const createInitialThreadPost = (): ThreadPost => ({
  id: crypto.randomUUID(),
  content: '',
})

export const useAppStore = create<AppState>((set, get) => ({
  currentUser: mockCurrentUser,
  isComposeOpen: false,
  replyingTo: null,
  quotingPost: null,
  threadPosts: [createInitialThreadPost()],
  activeThreadPostId: null,
  pendingPostNavigation: null,

  setCurrentUser: (user) => set({ currentUser: user }),
  setComposeOpen: (open) => {
    if (open) {
      // Reset thread posts when opening modal
      const initialPost = createInitialThreadPost()
      set({
        isComposeOpen: open,
        threadPosts: [initialPost],
        activeThreadPostId: initialPost.id
      })
    } else {
      // Reset thread posts when closing modal to prevent stale state
      const initialPost = createInitialThreadPost()
      set({
        isComposeOpen: false,
        threadPosts: [initialPost],
        activeThreadPostId: initialPost.id
      })
    }
  },
  setReplyingTo: (post) => set({ replyingTo: post }),
  setQuotingPost: (post) => set({ quotingPost: post }),

  addThreadPost: () => set((state) => {
    const newPost = createInitialThreadPost()
    return {
      threadPosts: [...state.threadPosts, newPost],
      activeThreadPostId: newPost.id,
    }
  }),

  removeThreadPost: (id) => set((state) => {
    const newPosts = state.threadPosts.filter(p => p.id !== id)
    // Ensure at least one post remains
    if (newPosts.length === 0) {
      const initialPost = createInitialThreadPost()
      return {
        threadPosts: [initialPost],
        activeThreadPostId: initialPost.id
      }
    }
    // Update active post if the removed one was active
    const newActiveId = state.activeThreadPostId === id
      ? newPosts[newPosts.length - 1].id
      : state.activeThreadPostId
    return {
      threadPosts: newPosts,
      activeThreadPostId: newActiveId
    }
  }),

  updateThreadPost: (id, content) => set((state) => ({
    threadPosts: state.threadPosts.map(p =>
      p.id === id ? { ...p, content } : p
    ),
  })),

  markThreadPostAsPosted: (id, postedPostId) => set((state) => ({
    threadPosts: state.threadPosts.map(p =>
      p.id === id ? { ...p, postedPostId } : p
    ),
  })),

  setActiveThreadPost: (id) => set({ activeThreadPostId: id }),

  resetThreadPosts: () => {
    const initialPost = createInitialThreadPost()
    set({
      threadPosts: [initialPost],
      activeThreadPostId: initialPost.id
    })
  },

  // Navigation actions for instant feed -> post detail transitions
  setPendingPostNavigation: (post, enrichment) => {
    set({
      pendingPostNavigation: { post, enrichment }
    })
  },

  consumePendingPostNavigation: (postId) => {
    const { pendingPostNavigation } = get()

    // Only consume if it matches the requested post
    if (pendingPostNavigation && pendingPostNavigation.post.id === postId) {
      // Clear the pending navigation after consuming
      set({ pendingPostNavigation: null })
      return pendingPostNavigation
    }

    return null
  },
}))

// Settings store with localStorage persistence
interface SettingsState {
  /** Enable link previews (fetches metadata via third-party proxy) */
  linkPreviews: boolean
  setLinkPreviews: (enabled: boolean) => void
  /** Send read receipts in direct messages */
  sendReadReceipts: boolean
  setSendReadReceipts: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      linkPreviews: false, // Disabled by default for privacy
      setLinkPreviews: (enabled) => set({ linkPreviews: enabled }),
      sendReadReceipts: true, // Enabled by default
      setSendReadReceipts: (enabled) => set({ sendReadReceipts: enabled }),
    }),
    {
      name: 'yappr-settings',
    }
  )
)

// Helper to get a stable ID from a feed item (handles both Post and FeedReplyContext)
const getFeedItemId = (item: FeedItem): string | undefined =>
  isFeedReplyContext(item) ? item.reply.id : item.id

// Feed state store - persists feed data across navigation
export interface FeedPagination {
  forYou: {
    lastPostId: string | null
    hasMore: boolean
  }
  following: {
    nextWindow: { start: Date; end: Date; windowHours: number } | null
    hasMore: boolean
  }
}

interface FeedState {
  // Feed posts by tab
  forYouPosts: FeedItem[] | null
  followingPosts: FeedItem[] | null
  // Pagination state
  pagination: FeedPagination
  // Scroll position by tab
  scrollPositions: {
    forYou: number
    following: number
  }
  // Track which user's following feed is cached
  followingUserId: string | null
  // Actions
  setForYouPosts: (posts: FeedItem[] | null) => void
  setFollowingPosts: (posts: FeedItem[] | null, userId: string | null) => void
  appendForYouPosts: (posts: FeedItem[]) => void
  appendFollowingPosts: (posts: FeedItem[]) => void
  setForYouPagination: (lastPostId: string | null, hasMore: boolean) => void
  setFollowingPagination: (nextWindow: { start: Date; end: Date; windowHours: number } | null, hasMore: boolean) => void
  setScrollPosition: (tab: 'forYou' | 'following', position: number) => void
  clearFeedState: (tab?: 'forYou' | 'following') => void
}

export const useFeedStore = create<FeedState>((set) => ({
  forYouPosts: null,
  followingPosts: null,
  pagination: {
    forYou: {
      lastPostId: null,
      hasMore: true,
    },
    following: {
      nextWindow: null,
      hasMore: true,
    },
  },
  scrollPositions: {
    forYou: 0,
    following: 0,
  },
  followingUserId: null,

  setForYouPosts: (posts) =>
    set({ forYouPosts: posts }),

  setFollowingPosts: (posts, userId) =>
    set({ followingPosts: posts, followingUserId: userId }),

  appendForYouPosts: (posts) =>
    set((state) => {
      const existingIds = new Set((state.forYouPosts || []).map(getFeedItemId).filter(Boolean))
      const newPosts = posts.filter((p) => {
        const id = getFeedItemId(p)
        return !id || !existingIds.has(id)
      })
      return { forYouPosts: [...(state.forYouPosts || []), ...newPosts] }
    }),

  appendFollowingPosts: (posts) =>
    set((state) => {
      const existingIds = new Set((state.followingPosts || []).map(getFeedItemId).filter(Boolean))
      const newPosts = posts.filter((p) => {
        const id = getFeedItemId(p)
        return !id || !existingIds.has(id)
      })
      return { followingPosts: [...(state.followingPosts || []), ...newPosts] }
    }),

  setForYouPagination: (lastPostId, hasMore) =>
    set((state) => ({
      pagination: {
        ...state.pagination,
        forYou: { lastPostId, hasMore },
      },
    })),

  setFollowingPagination: (nextWindow, hasMore) =>
    set((state) => ({
      pagination: {
        ...state.pagination,
        following: { nextWindow, hasMore },
      },
    })),

  setScrollPosition: (tab, position) =>
    set((state) => ({
      scrollPositions: {
        ...state.scrollPositions,
        [tab]: position,
      },
    })),

  clearFeedState: (tab) =>
    set((state) => {
      if (tab === 'forYou') {
        return {
          forYouPosts: null,
          pagination: {
            ...state.pagination,
            forYou: { lastPostId: null, hasMore: true },
          },
          scrollPositions: { ...state.scrollPositions, forYou: 0 },
        }
      }
      if (tab === 'following') {
        return {
          followingPosts: null,
          followingUserId: null,
          pagination: {
            ...state.pagination,
            following: { nextWindow: null, hasMore: true },
          },
          scrollPositions: { ...state.scrollPositions, following: 0 },
        }
      }
      // Clear all if no tab specified
      return {
        forYouPosts: null,
        followingPosts: null,
        followingUserId: null,
        pagination: {
          forYou: { lastPostId: null, hasMore: true },
          following: { nextWindow: null, hasMore: true },
        },
        scrollPositions: { forYou: 0, following: 0 },
      }
    }),
}))
