'use client'

import { create } from 'zustand'

interface LoginModalStore {
  isOpen: boolean
  open: () => void
  close: () => void
}

/**
 * Global store for the login modal.
 * Use this to show the login modal from anywhere in the app.
 */
export const useLoginModal = create<LoginModalStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}))
