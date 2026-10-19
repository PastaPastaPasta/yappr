// Stands in for lib/auth/passkey-vault in the
// passkey enrolment fixture: each step resolves once the test releases it, so a test
// can look at the dialog while the browser's passkey sheet would be open.
// The real module is aliased to this one here, so its error class is restated rather than re-exported;
// each stand-in is typed as the real export, so a changed signature fails the type check.
import type * as Vault from '../../lib/auth/passkey-vault'

export type { PasskeyEntryView, PasskeyErrorCode, PasskeyRenewal, PendingPasskey } from '../../lib/auth/passkey-vault'

export class PasskeyVaultError extends Error {
  constructor(readonly code: Vault.PasskeyErrorCode, message?: string) {
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

export const passkeysOffered: typeof Vault.passkeysOffered = () => true
export const pendingEnrolmentFor: typeof Vault.pendingEnrolmentFor = () => null
export const forgetPendingEnrolments: typeof Vault.forgetPendingEnrolments = () => {}
export const listPasskeys: typeof Vault.listPasskeys = async () => []
export const passkeyEligibility: typeof Vault.passkeyEligibility = async () => null
export const abandonPasskeyEnrolment: typeof Vault.abandonPasskeyEnrolment = async () => {}
export const startPasskeyEnrolment: typeof Vault.startPasskeyEnrolment = ({ identityId }) =>
  sheet({ identityId, credentialId: new Uint8Array([1]), createPrf: null })
export const finishPasskeyEnrolment: typeof Vault.finishPasskeyEnrolment = () => sheet(undefined)
export const checkPendingEnrolment: typeof Vault.checkPendingEnrolment = async () => 'saved'
export const confirmPendingEnrolment: typeof Vault.confirmPendingEnrolment = async () => 'saved'
export const updatePasskeys: typeof Vault.updatePasskeys = async () => ({ updated: 0, failed: 0 })
export const removePasskeys: typeof Vault.removePasskeys = async () => ({ removed: 0, failed: 0 })
export const removeAllPasskeys: typeof Vault.removeAllPasskeys = async () => ({ removed: 0, failed: 0 })
