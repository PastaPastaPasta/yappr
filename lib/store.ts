import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { User, Post } from './types'
import { mockCurrentUser } from './mock-data'

interface AppState {
  currentUser: User | null
  isComposeOpen: boolean
  replyingTo: Post | null
  quotingPost: Post | null
  editingPost: Post | null

  setCurrentUser: (user: User | null) => void
  setComposeOpen: (open: boolean) => void
  setReplyingTo: (post: Post | null) => void
  setQuotingPost: (post: Post | null) => void
  setEditingPost: (post: Post | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  currentUser: mockCurrentUser,
  isComposeOpen: false,
  replyingTo: null,
  quotingPost: null,
  editingPost: null,

  setCurrentUser: (user) => set({ currentUser: user }),
  setComposeOpen: (open) => set({ isComposeOpen: open }),
  setReplyingTo: (post) => set({ replyingTo: post }),
  setQuotingPost: (post) => set({ quotingPost: post }),
  setEditingPost: (post) => set({
    editingPost: post,
    replyingTo: null,  // Clear other modes for mutual exclusivity
    quotingPost: null
  }),
}))

// Settings store with localStorage persistence
interface SettingsState {
  /** Enable rich link previews (fetches metadata via third-party proxy) */
  richLinkPreviews: boolean
  setRichLinkPreviews: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      richLinkPreviews: false, // Disabled by default for privacy
      setRichLinkPreviews: (enabled) => set({ richLinkPreviews: enabled }),
    }),
    {
      name: 'yappr-settings',
    }
  )
)
