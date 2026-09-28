import { matchIdentityKey, type IdentityKeyLike } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { logger } from '@/lib/logger'

/**
 * Whether the stored private key `wif` signs for the session identity: it
 * matches one of the identity's enabled CRITICAL or HIGH AUTHENTICATION keys,
 * the only keys that sign documents. Login already
 * refuses any other key, so a mismatch at restore means the key slot was
 * overwritten or corrupted, and the session must not be restored with it.
 *
 * The session's own copy of the keys (saved at login) is checked first, and
 * the identity is only fetched when that copy is empty (older or seeded
 * sessions) or does not match, so an unreadable copy cannot log anyone out.
 * If the fetch fails the key is trusted, as before: being offline must not
 * end the session, and a wrong key still fails when it signs.
 */
export async function storedKeyBelongsToIdentity(
  wif: string,
  sessionKeys: readonly IdentityKeyLike[],
  fetchKeys: () => Promise<readonly IdentityKeyLike[] | null>,
  network: 'testnet' | 'mainnet'
): Promise<boolean> {
  const matches = (keys: readonly IdentityKeyLike[]) =>
    matchIdentityKey(wif, keys, {
      network,
      purpose: KeyPurpose.AUTHENTICATION,
      allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
    }).ok
  if (matches(sessionKeys)) return true
  try {
    const fetched = await fetchKeys()
    return fetched !== null && matches(fetched)
  } catch (error) {
    logger.warn('Session restore: could not fetch identity keys; trusting the stored key:', error)
    return true
  }
}
