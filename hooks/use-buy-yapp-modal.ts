import { create } from 'zustand'

interface BuyYappModalStore {
  isOpen: boolean
  /** Optional reason shown at the top (e.g. "You need YAPP to post"). */
  reason: string | null
  open: (reason?: string) => void
  close: () => void
}

export const useBuyYappModal = create<BuyYappModalStore>((set) => ({
  isOpen: false,
  reason: null,
  open: (reason) => set({ isOpen: true, reason: reason ?? null }),
  close: () => set({ isOpen: false, reason: null }),
}))
