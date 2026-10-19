// Stands in for lib/auth/passkey-vault in the
// passkey enrolment fixture: each step resolves once the test releases it, so a test
// can look at the dialog while the browser's passkey sheet would be open.
// The real module is aliased to this one here, so its error class is restated rather than re-exported.
import type { PasskeyErrorCode, PendingPasskey } from '../../lib/auth/passkey-vault'

export type { PasskeyEntryView, PasskeyErrorCode, PasskeyRenewal, PendingPasskey } from '../../lib/auth/passkey-vault'

export class PasskeyVaultError extends Error {
  constructor(readonly code: PasskeyErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'PasskeyVaultError'
  }
}

declare global {
  interface Window {
    /** Finishes the passkey sheet the dialog is waiting on. */
    releasePasskeySheet?: () => void
  }
}

function sheet<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    window.releasePasskeySheet = () => {
      window.releasePasskeySheet = undefined
      resolve(value)
    }
  })
}

export const passkeysOffered = () => true
export const pendingEnrolmentFor = () => null
export const forgetPendingEnrolments = () => {}
export const listPasskeys = async () => []
export const passkeyEligibility = async () => null
export const abandonPasskeyEnrolment = async () => {}
export const startPasskeyEnrolment = ({ identityId }: { identityId: string }): Promise<PendingPasskey> =>
  sheet({ identityId, credentialId: new Uint8Array([1]), createPrf: null })
export const finishPasskeyEnrolment = (): Promise<void> => sheet(undefined)
export const checkPendingEnrolment = async () => 'saved' as const
export const confirmPendingEnrolment = async () => 'saved' as const
export const updatePasskeys = async () => ({ updated: 0, failed: 0 })
export const removePasskeys = async () => ({ removed: 0, failed: 0 })
export const removeAllPasskeys = async () => ({ removed: 0, failed: 0 })

