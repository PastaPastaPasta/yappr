import { create } from 'zustand'
import { DeletionProgress, DeletionResult, DocumentCounts } from '@/lib/services/account-deletion-service'

export type DeleteAccountStep = 'warning' | 'confirm' | 'progress' | 'complete' | 'error'

interface DeleteAccountModalStore {
  isOpen: boolean
  step: DeleteAccountStep
  progress: DeletionProgress | null
  result: DeletionResult | null
  documentCounts: DocumentCounts | null
  isLoadingCounts: boolean

  // Actions
  open: () => void
  close: () => void
  setStep: (step: DeleteAccountStep) => void
  setProgress: (progress: DeletionProgress) => void
  setResult: (result: DeletionResult) => void
  setDocumentCounts: (counts: DocumentCounts) => void
  setIsLoadingCounts: (loading: boolean) => void
  reset: () => void
}

const initialState = {
  isOpen: false,
  step: 'warning' as DeleteAccountStep,
  progress: null,
  result: null,
  documentCounts: null,
  isLoadingCounts: false
}

export const useDeleteAccountModal = create<DeleteAccountModalStore>((set) => ({
  ...initialState,

  open: () => set({ isOpen: true, step: 'warning' }),

  close: () => set({ isOpen: false }),

  setStep: (step) => set({ step }),

  setProgress: (progress) => set({ progress }),

  setResult: (result) => set({ result }),

  setDocumentCounts: (documentCounts) => set({ documentCounts }),

  setIsLoadingCounts: (isLoadingCounts) => set({ isLoadingCounts }),

  reset: () => set(initialState)
}))
