// Test-only identity service: no identity is read and nothing reaches Platform.
const fixture = new URLSearchParams(window.location.search).get('fixture')
const updates = { sent: 0, cancelled: 0 }
let releaseLock: () => void = () => undefined
const lock = new Promise<void>((resolve) => { releaseLock = resolve })

declare global {
  interface Window {
    identityUpdates?: typeof updates
    releaseIdentityUpdateLock?: () => void
  }
}
window.identityUpdates = updates
window.releaseIdentityUpdateLock = () => releaseLock()

export const identityService = {
  hasEncryptionKey: async () => fixture !== 'encryption-key-modal',
  validateKeySecurityLevel: async () => ({ isValid: true, keyId: 0, securityLevel: 'MASTER' }),
  /** As the real one: waits for the identity update lock (another tab's update), asks the cancel check, then sends. */
  addEncryptionKey: async (_identityId: string, _key: Uint8Array, _master: string, _contractId?: string, options: { cancelled?: () => boolean } = {}) => {
    await lock
    if (options.cancelled?.()) {
      updates.cancelled += 1
      return { success: false, cancelled: true }
    }
    updates.sent += 1
    return { success: true, keyId: 3 }
  },
}
