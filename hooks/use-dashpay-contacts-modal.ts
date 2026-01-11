import { create } from 'zustand'
import { DashPayContact, UnfollowedContactsResult } from '@/lib/services/dashpay-contacts-service'

type ModalState = 'idle' | 'loading' | 'ready' | 'following' | 'error'

interface DashPayContactsModalStore {
  isOpen: boolean
  state: ModalState
  contacts: DashPayContact[]
  totalMutualContacts: number
  alreadyFollowedCount: number
  error: string | null
  followingIds: Set<string>

  // Actions
  open: () => void
  close: () => void
  setLoading: () => void
  setReady: (result: UnfollowedContactsResult) => void
  setError: (error: string) => void
  setFollowing: (contactId: string) => void
  setFollowComplete: (contactId: string) => void
  setFollowAll: () => void
  reset: () => void
}

export const useDashPayContactsModal = create<DashPayContactsModalStore>((set) => ({
  isOpen: false,
  state: 'idle',
  contacts: [],
  totalMutualContacts: 0,
  alreadyFollowedCount: 0,
  error: null,
  followingIds: new Set(),

  open: () => set({ isOpen: true, state: 'loading', error: null }),

  close: () => set({ isOpen: false }),

  setLoading: () => set({ state: 'loading', error: null }),

  setReady: (result) => set({
    state: 'ready',
    contacts: result.contacts,
    totalMutualContacts: result.totalMutualContacts,
    alreadyFollowedCount: result.alreadyFollowedCount
  }),

  setError: (error) => set({ state: 'error', error }),

  setFollowing: (contactId) => set((state) => ({
    followingIds: new Set(Array.from(state.followingIds).concat(contactId))
  })),

  setFollowComplete: (contactId) => set((state) => ({
    contacts: state.contacts.filter(c => c.identityId !== contactId),
    alreadyFollowedCount: state.alreadyFollowedCount + 1,
    followingIds: new Set(Array.from(state.followingIds).filter(id => id !== contactId))
  })),

  setFollowAll: () => set({ state: 'following' }),

  reset: () => set({
    isOpen: false,
    state: 'idle',
    contacts: [],
    totalMutualContacts: 0,
    alreadyFollowedCount: 0,
    error: null,
    followingIds: new Set()
  })
}))
