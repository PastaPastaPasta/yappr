'use client'

import { create } from 'zustand'

interface KeyExchangeModalStore {
  /** Whether the modal is open */
  isOpen: boolean
  /** The identity ID to use for key exchange (null if not set) */
  identityId: string | null
  /** The DPNS username (for display) */
  dpnsUsername: string | null
  /** Open the modal for a specific identity */
  open: (identityId: string, dpnsUsername?: string) => void
  /** Close the modal */
  close: () => void
}

/**
 * Global store for the key exchange login modal.
 * Use this to show the key exchange modal from anywhere in the app.
 */
export const useKeyExchangeModal = create<KeyExchangeModalStore>((set) => ({
  isOpen: false,
  identityId: null,
  dpnsUsername: null,
  open: (identityId: string, dpnsUsername?: string) => set({
    isOpen: true,
    identityId,
    dpnsUsername: dpnsUsername || null
  }),
  close: () => set({
    isOpen: false,
    identityId: null,
    dpnsUsername: null
  }),
}))
