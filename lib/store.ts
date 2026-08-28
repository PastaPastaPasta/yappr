import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User, Post } from './types'
import { mockCurrentUser } from './mock-data'
import { ProgressiveEnrichment } from '@/components/post/post-card'
import type { ReadingMode, FontSizeLevel } from '@/lib/blog/reader-preferences'
import { scopedKey } from '@/lib/storage-scope'

export type PostVisibility = 'public' | 'private' | 'private-with-teaser'

export interface ThreadPost {
  id: string
  content: string
  postedPostId?: string // Platform post ID if successfully posted
  visibility?: PostVisibility // Post visibility (only applies to first post in thread)
  teaser?: string // Teaser content for private-with-teaser posts
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
  updateThreadPostVisibility: (id: string, visibility: PostVisibility) => void
  updateThreadPostTeaser: (id: string, teaser: string) => void
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
  visibility: 'public',
  teaser: '',
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

  updateThreadPostVisibility: (id, visibility) => set((state) => ({
    threadPosts: state.threadPosts.map(p =>
      p.id === id ? { ...p, visibility } : p
    ),
  })),

  updateThreadPostTeaser: (id, teaser) => set((state) => ({
    threadPosts: state.threadPosts.map(p =>
      p.id === id ? { ...p, teaser } : p
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
interface NotificationSettings {
  likes: boolean
  reposts: boolean
  replies: boolean
  follows: boolean
  mentions: boolean
  messages: boolean
  blogPosts: boolean
}

/**
 * How the viewer wants author-flagged sensitive (NSFW) posts handled:
 * blur = gate behind an opaque warning with a per-post reveal (default),
 * show = never gate, hide = remove from list feeds entirely (detail pages,
 * threads and bookmarks still show the gate so conversations keep their shape).
 */
export type SensitiveContentMode = 'blur' | 'show' | 'hide'

interface SettingsState {
  /** Fetch link previews and post media (opt-out; disabling stops all preview fetches) */
  linkPreviewsEnabled: boolean
  setLinkPreviewsEnabled: (enabled: boolean) => void
  /** Hide media/previews from non-followed authors behind a click-to-reveal placeholder */
  gateMediaFromNonFollowed: boolean
  setGateMediaFromNonFollowed: (enabled: boolean) => void
  /** Send read receipts in direct messages */
  sendReadReceipts: boolean
  setSendReadReceipts: (enabled: boolean) => void
  /** Notification preferences - which types to show */
  notificationSettings: NotificationSettings
  setNotificationSettings: (settings: Partial<NotificationSettings>) => void
  /** Potato Mode: Disable visual effects like backdrop blur for better performance on older devices */
  potatoMode: boolean
  setPotatoMode: (enabled: boolean) => void
  /** Preferred language for the For You feed */
  feedLanguage: string
  setFeedLanguage: (language: string) => void
  /** How to treat posts the author flagged as sensitive */
  sensitiveContentMode: SensitiveContentMode
  setSensitiveContentMode: (mode: SensitiveContentMode) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      linkPreviewsEnabled: true, // Opt-out: previews/media fetch by default
      setLinkPreviewsEnabled: (enabled) => set({ linkPreviewsEnabled: enabled }),
      gateMediaFromNonFollowed: true, // Media from non-followed authors is blurred until revealed
      setGateMediaFromNonFollowed: (enabled) => set({ gateMediaFromNonFollowed: enabled }),
      sendReadReceipts: true, // Enabled by default
      setSendReadReceipts: (enabled) => set({ sendReadReceipts: enabled }),
      notificationSettings: {
        likes: true,
        reposts: true,
        replies: true,
        follows: true,
        mentions: true,
        messages: true,
        blogPosts: true,
      },
      setNotificationSettings: (settings) =>
        set((state) => ({
          notificationSettings: { ...state.notificationSettings, ...settings },
        })),
      potatoMode: false, // Disabled by default - blur effects enabled
      setPotatoMode: (enabled) => set({ potatoMode: enabled }),
      feedLanguage: 'en', // Default to English
      setFeedLanguage: (language) => set({ feedLanguage: language }),
      sensitiveContentMode: 'blur' as SensitiveContentMode,
      setSensitiveContentMode: (mode) => set({ sensitiveContentMode: mode }),
    }),
    {
      name: scopedKey('yappr-settings'),
      version: 1,
      migrate: (persistedState, version) => {
        const state = (persistedState ?? {}) as Partial<SettingsState> & { linkPreviewsChoice?: string }
        if (version === 0) {
          // v0 stored a tri-state linkPreviewsChoice; only an explicit
          // 'disabled' opt-out carries over now that previews default on.
          state.linkPreviewsEnabled = state.linkPreviewsChoice !== 'disabled'
          delete state.linkPreviewsChoice
        }
        return state as SettingsState
      },
    }
  )
)

// Reader preferences store (font size + reading mode for blog posts)
interface ReaderPreferencesState {
  readingMode: ReadingMode
  fontSize: FontSizeLevel
  setReadingMode: (mode: ReadingMode) => void
  setFontSize: (size: FontSizeLevel) => void
  resetPreferences: () => void
}

export const useReaderPreferencesStore = create<ReaderPreferencesState>()(
  persist(
    (set) => ({
      readingMode: 'author',
      fontSize: 'medium',
      setReadingMode: (mode) => set({ readingMode: mode }),
      setFontSize: (size) => set({ fontSize: size }),
      resetPreferences: () => set({ readingMode: 'author', fontSize: 'medium' }),
    }),
    { name: scopedKey('yappr-reader-prefs') }
  )
)
