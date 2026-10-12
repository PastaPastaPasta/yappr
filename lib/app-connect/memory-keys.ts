/**
 * The App Connect encryption key, unwrapped from the key ring when the
 * session is restored or created, so the private-feed and DM code that reads
 * the encryption key synchronously (`lib/secure-storage.ts`) keeps working.
 * It lives in memory only; the key ring holds the wrapped copy.
 *
 * Kept free of the SDK so secure-storage can import it without pulling the
 * App Connect runtime into every bundle that reads a key.
 */

let encryptionKey: { identityId: string; wif: string } | null = null
/** The identity this tab is signed in as through a wallet (App Connect), or null. */
let sessionIdentity: string | null = null

export function setAppConnectSessionIdentity(identityId: string | null): void {
  sessionIdentity = identityId
}

export function hasAppConnectSession(identityId: string): boolean {
  return sessionIdentity === identityId
}

export function setAppConnectEncryptionKey(identityId: string, wif: string): void {
  encryptionKey = { identityId, wif }
}

export function clearAppConnectEncryptionKey(): void {
  encryptionKey = null
}

export function appConnectEncryptionKey(identityId: string): string | null {
  return encryptionKey?.identityId === identityId ? encryptionKey.wif : null
}
