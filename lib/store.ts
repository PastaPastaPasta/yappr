import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User, Post } from './types'
import { mockCurrentUser } from './mock-data'
import { ProgressiveEnrichment } from '@/components/post/post-card'

export interface ThreadPost {
  id: string
  content: string
  postedPostId?: string // Platform post ID if successfully posted
}

// Cache entry for posts seen in feed (for instant navigation)
export interface CachedPost {
  post: Post
  enrichment?: ProgressiveEnrichment
  cachedAt: number
}

interface AppState {
  currentUser: User | null
  isComposeOpen: boolean
  replyingTo: Post | null
  quotingPost: Post | null
  // Thread composition state
  threadPosts: ThreadPost[]
  activeThreadPostId: string | null
  // Post cache for instant navigation from feed to post detail
  postCache: Map<string, CachedPost>

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
  // Post cache actions
  cachePost: (post: Post, enrichment?: ProgressiveEnrichment) => void
  getCachedPost: (postId: string) => CachedPost | undefined
  clearPostCache: () => void
}

const createInitialThreadPost = (): ThreadPost => ({
  id: crypto.randomUUID(),
  content: '',
})

// Cache TTL: 5 minutes
const POST_CACHE_TTL = 5 * 60 * 1000
// Max cache size to prevent memory issues
const MAX_CACHE_SIZE = 100

export const useAppStore = create<AppState>((set, get) => ({
  currentUser: mockCurrentUser,
  isComposeOpen: false,
  replyingTo: null,
  quotingPost: null,
  threadPosts: [createInitialThreadPost()],
  activeThreadPostId: null,
  postCache: new Map(),

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

  // Post cache actions for instant navigation
  cachePost: (post, enrichment) => {
    const { postCache } = get()
    const now = Date.now()

    // Create new map to trigger React update
    const newCache = new Map(postCache)

    // Add/update the post
    newCache.set(post.id, {
      post,
      enrichment,
      cachedAt: now
    })

    // Clean up expired entries and enforce max size
    const entries = Array.from(newCache.entries())
    const validEntries = entries
      .filter(([, entry]) => now - entry.cachedAt < POST_CACHE_TTL)
      .sort((a, b) => b[1].cachedAt - a[1].cachedAt) // Most recent first
      .slice(0, MAX_CACHE_SIZE)

    set({ postCache: new Map(validEntries) })
  },

  getCachedPost: (postId) => {
    const { postCache } = get()
    const cached = postCache.get(postId)

    if (!cached) return undefined

    // Check if still valid
    if (Date.now() - cached.cachedAt > POST_CACHE_TTL) {
      // Expired - remove it
      const newCache = new Map(postCache)
      newCache.delete(postId)
      set({ postCache: newCache })
      return undefined
    }

    return cached
  },

  clearPostCache: () => {
    set({ postCache: new Map() })
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
