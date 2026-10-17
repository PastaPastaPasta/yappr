import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { passkeysOffered, type PendingPasskey } from '@/lib/auth/passkey-vault'

/** How the session came about. A renewal replaces a signed-in session's wallet keys: it checks passkeys, but never offers one. */
export type SignInMethod = 'key' | 'wallet' | 'passkey' | 'renewal'

export type PasskeyDialog = { kind: 'offer' | 'enrol' | 'review'; identityId: string }

interface PasskeyPromptsState {
  /** The last sign-in this tab made (not a restored session), for the one-time offer and the update check. */
  signedIn: { identityId: string; method: SignInMethod; at: number; epoch: number } | null
  /** An enrolment whose entry is still settling: the dialog resumes it, offering only "Check again". */
  pendingEnrolment: PendingPasskey | null
  /** The open passkey dialog, if any (components/auth/passkey-prompts.tsx). */
  dialog: PasskeyDialog | null
  /** Bumped whenever passkeys were added, updated or removed, so lists read them again. */
  revision: number
  /** `epoch`: the auth controller's session epoch the sign-in left; a sign-out moves it on at once. */
  noteSignIn: (identityId: string, method: SignInMethod, epoch: number) => void
  setPendingEnrolment: (pending: PendingPasskey | null) => void
  open: (kind: PasskeyDialog['kind'], identityId: string) => void
  close: () => void
  changed: () => void
  /** The session ended: forget its sign-in and close its dialog. */
  reset: () => void
}

export const usePasskeyPrompts = create<PasskeyPromptsState>((set) => ({
  signedIn: null,
  dialog: null,
  pendingEnrolment: null,
  revision: 0,
  noteSignIn: (identityId, method, epoch) => set({ signedIn: { identityId, method, at: Date.now(), epoch } }),
  setPendingEnrolment: (pendingEnrolment) => set({ pendingEnrolment }),
  open: (kind, identityId) => set({ dialog: { kind, identityId } }),
  close: () => set({ dialog: null }),
  changed: () => set((state) => ({ revision: state.revision + 1 })),
  reset: () => set({ signedIn: null, dialog: null, pendingEnrolment: null }),
}))

/** Whether this page offers passkeys, decided after mount: it reads the page's host, which the static export does not know. */
export function usePasskeysOffered(): boolean {
  const [offered, setOffered] = useState(false)
  useEffect(() => setOffered(passkeysOffered()), [])
  return offered
}
