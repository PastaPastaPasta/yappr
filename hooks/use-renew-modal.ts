import { createModalStore } from '@/lib/modal-store'

interface RenewPayload {
  /** Runs once the wallet's renewal has been verified and stored. */
  onRenewed: (() => void) | undefined
}

/** The App Connect "Renew in your wallet" dialog (components/auth/app-connect-session-notices.tsx). */
export const useRenewModal = createModalStore<RenewPayload, [onRenewed?: () => void]>(
  { onRenewed: undefined },
  (onRenewed) => ({ onRenewed }),
)
