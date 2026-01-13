import { create } from 'zustand'
import { User, Post } from './types'
import { mockCurrentUser } from './mock-data'

interface AppState {
  currentUser: User | null
  isComposeOpen: boolean
  replyingTo: Post | null
  quotingPost: Post | null

  setCurrentUser: (user: User | null) => void
  setComposeOpen: (open: boolean) => void
  setReplyingTo: (post: Post | null) => void
  setQuotingPost: (post: Post | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  currentUser: mockCurrentUser,
  isComposeOpen: false,
  replyingTo: null,
  quotingPost: null,

  setCurrentUser: (user) => set({ currentUser: user }),
  setComposeOpen: (open) => set({ isComposeOpen: open }),
  setReplyingTo: (post) => set({ replyingTo: post }),
  setQuotingPost: (post) => set({ quotingPost: post }),
}))
