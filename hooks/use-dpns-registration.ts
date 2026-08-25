import { create } from 'zustand'
import type { UsernameEntry, RegistrationStep, UsernameStatus } from '@/lib/types'

interface DpnsRegistrationStore {
  // State
  step: RegistrationStep
  usernames: UsernameEntry[]
  contestedAcknowledged: boolean
  currentRegistrationIndex: number

  // Actions
  setStep: (step: RegistrationStep) => void
  addUsername: () => void
  removeUsername: (id: string) => void
  updateUsernameLabel: (id: string, label: string) => void
  updateUsernameStatus: (id: string, status: UsernameStatus, validationError?: string) => void
  setUsernameContested: (id: string, isContested: boolean) => void
  setUsernameRegistered: (id: string, success: boolean, error?: string) => void
  setContestedAcknowledged: (acknowledged: boolean) => void
  setCurrentRegistrationIndex: (index: number) => void
  reset: () => void

  // Computed helpers
  hasContestedUsernames: () => boolean
  getAvailableUsernames: () => UsernameEntry[]
  getValidUsernames: () => UsernameEntry[]
}

const createInitialUsername = (): UsernameEntry => ({
  id: crypto.randomUUID(),
  label: '',
  status: 'pending',
  isContested: false,
})

const initialState = {
  step: 'username-entry' as RegistrationStep,
  usernames: [createInitialUsername()],
  contestedAcknowledged: false,
  currentRegistrationIndex: 0,
}

export const useDpnsRegistration = create<DpnsRegistrationStore>((set, get) => ({
  ...initialState,

  setStep: (step) => set({ step }),

  addUsername: () =>
    set((state) => ({
      usernames: [...state.usernames, createInitialUsername()],
    })),

  removeUsername: (id) =>
    set((state) => ({
      usernames: state.usernames.filter((u) => u.id !== id),
    })),

  updateUsernameLabel: (id, label) =>
    set((state) => ({
      usernames: state.usernames.map((u) =>
        u.id === id
          ? { ...u, label, status: 'pending' as UsernameStatus, validationError: undefined, isContested: false }
          : u
      ),
    })),

  updateUsernameStatus: (id, status, validationError) =>
    set((state) => ({
      usernames: state.usernames.map((u) =>
        u.id === id ? { ...u, status, validationError } : u
      ),
    })),

  setUsernameContested: (id, isContested) =>
    set((state) => ({
      usernames: state.usernames.map((u) =>
        u.id === id ? { ...u, isContested } : u
      ),
    })),

  setUsernameRegistered: (id, success, error) =>
    set((state) => ({
      usernames: state.usernames.map((u) =>
        u.id === id
          ? { ...u, registered: success, registrationError: error }
          : u
      ),
    })),

  setContestedAcknowledged: (acknowledged) =>
    set({ contestedAcknowledged: acknowledged }),

  setCurrentRegistrationIndex: (index) =>
    set({ currentRegistrationIndex: index }),

  reset: () => set({ ...initialState, usernames: [createInitialUsername()] }),

  hasContestedUsernames: () =>
    get().usernames.some((u) => u.isContested && (u.status === 'available' || u.status === 'contested')),

  getAvailableUsernames: () =>
    get().usernames.filter((u) => u.status === 'available' || u.status === 'contested'),

  getValidUsernames: () =>
    get().usernames.filter((u) => u.label.trim() && u.status !== 'invalid'),
}))
