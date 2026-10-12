import { createModalStore } from '@/lib/modal-store'

/** The App Connect "Renew in your wallet" dialog (components/auth/app-connect-session-notices.tsx). */
export const useRenewModal = createModalStore<Record<never, never>>({})
