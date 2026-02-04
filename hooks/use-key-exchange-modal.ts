'use client'

import { create } from 'zustand'

interface KeyExchangeModalStore {
  /** Whether the modal is open */
  isOpen: boolean
  /** Open the modal */
  open: () => void
  /** Close the modal */
  close: () => void
}

/**
 * Global store for the key exchange login modal.
 * Use this to show the key exchange modal from anywhere in the app.
 */
export const useKeyExchangeModal = create<KeyExchangeModalStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}))
