import { create } from 'zustand'

export type SignInMethod = 'key' | 'wallet' | 'passkey'

interface PasskeyPromptsState {
  /** The last sign-in this tab made (not a restored session), for the one-time offer and the update check. */
  signedIn: { identityId: string; method: SignInMethod; at: number } | null
  /** Open dialogs, by the identity they are for. */
  offer: string | null
  enrol: string | null
  review: string | null
  noteSignIn: (identityId: string, method: SignInMethod) => void
  openOffer: (identityId: string) => void
  openEnrol: (identityId: string) => void
  openReview: (identityId: string) => void
  close: () => void
}

/** The passkey offer, enrolment and update-review dialogs (components/auth/passkey-prompts.tsx). */
export const usePasskeyPrompts = create<PasskeyPromptsState>((set) => ({
  signedIn: null,
  offer: null,
  enrol: null,
  review: null,
  noteSignIn: (identityId, method) => set({ signedIn: { identityId, method, at: Date.now() } }),
  openOffer: (identityId) => set({ offer: identityId, enrol: null, review: null }),
  openEnrol: (identityId) => set({ offer: null, enrol: identityId, review: null }),
  openReview: (identityId) => set({ offer: null, enrol: null, review: identityId }),
  close: () => set({ offer: null, enrol: null, review: null }),
}))
