// Test-only identity service: no identity is read and nothing reaches Platform.
const fixture = new URLSearchParams(window.location.search).get('fixture')
const updates = { sent: 0, cancelled: 0 }
let releaseLock: () => void = () => undefined
const lock = new Promise<void>((resolve) => { releaseLock = resolve })
let confirm: () => void = () => undefined
const confirmation = new Promise<void>((resolve) => { confirm = resolve })

declare global {
  interface Window {
    identityUpdates?: typeof updates
    releaseIdentityUpdateLock?: () => void
    confirmIdentityUpdate?: () => void
  }
}
window.identityUpdates = updates
window.releaseIdentityUpdateLock = () => releaseLock()
window.confirmIdentityUpdate = () => confirm()

export const STALE_IDENTITY_ERROR = "Your account's latest change hasn't reached the network yet. Try again in a moment."

export const identityService = {
  hasEncryptionKey: async () => fixture !== 'encryption-key-modal',
  getBalance: async () => ({ confirmed: 1_000_000_000_000 }),
  validateKeySecurityLevel: async () => ({ isValid: true, keyId: 0, securityLevel: 'MASTER' }),
  /** As the real one: waits for the identity update lock (another tab's update), asks the cancel check, sends, then waits for confirmation. */
  addEncryptionKey: async (_identityId: string, _key: Uint8Array, _master: string, _contractId?: string, options: { cancelled?: () => boolean } = {}) => {
    await lock
    if (options.cancelled?.()) {
      updates.cancelled += 1
      return { success: false, cancelled: true }
    }
    updates.sent += 1
    await confirmation
    return { success: true, keyId: 3 }
  },
}
