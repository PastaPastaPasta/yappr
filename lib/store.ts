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
  /** Potato Mode: Disable visual effects like backdrop blur for better performance on older devices */
  potatoMode: boolean
  setPotatoMode: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      linkPreviews: false, // Disabled by default for privacy
      setLinkPreviews: (enabled) => set({ linkPreviews: enabled }),
      sendReadReceipts: true, // Enabled by default
      setSendReadReceipts: (enabled) => set({ sendReadReceipts: enabled }),
      potatoMode: false, // Disabled by default - blur effects enabled
      setPotatoMode: (enabled) => set({ potatoMode: enabled }),
    }),
    {
      name: 'yappr-settings',
    }
  )
)
