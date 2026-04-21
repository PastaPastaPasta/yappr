import { create } from 'zustand'

interface KeyBackupModalStore {
  isOpen: boolean
  identityId?: string
  username?: string
  redirectOnClose: boolean
  open: (identityId: string, username: string, redirectOnClose?: boolean) => void
  close: () => void
}

export const useKeyBackupModal = create<KeyBackupModalStore>((set) => ({
  isOpen: false,
  identityId: undefined,
  username: undefined,
  redirectOnClose: true,
  open: (identityId, username, redirectOnClose = true) => set({
    isOpen: true,
    identityId,
    username,
    redirectOnClose
  }),
  close: () => set({
    isOpen: false,
    identityId: undefined,
    username: undefined,
    redirectOnClose: true
  }),
}))
