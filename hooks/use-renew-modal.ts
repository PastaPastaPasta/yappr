import { createModalStore } from '@/lib/modal-store'

interface RenewPayload {
  /** Runs once the wallet's renewal has been verified and stored. */
  onRenewed: (() => void) | undefined
}

/** Fired on `window` after any renewal lands, whoever opened the dialog. */
export const APP_CONNECT_RENEWED_EVENT = 'yappr-app-connect-renewed'

/** The App Connect "Renew in your wallet" dialog (components/auth/app-connect-session-notices.tsx). */
export const useRenewModal = createModalStore<RenewPayload, [onRenewed?: () => void]>(
  { onRenewed: undefined },
  (onRenewed) => ({ onRenewed }),
)
