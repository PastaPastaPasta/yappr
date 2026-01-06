import { create } from 'zustand'
import { Post } from '@/lib/types'

interface TipModalStore {
  isOpen: boolean
  post: Post | null
  open: (post: Post) => void
  close: () => void
}

export const useTipModal = create<TipModalStore>((set) => ({
  isOpen: false,
  post: null,
  open: (post) => set({ isOpen: true, post }),
  close: () => set({ isOpen: false, post: null }),
}))
