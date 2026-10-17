import { identityService } from './identity-service'
import { checkLoginKey, checkLoginKeyFormat, type LoginKeyResult } from '@/lib/auth/login-key'

class KeyValidationService {
  /**
   * Whether a typed-in private key may sign `identityId` in: one of its
   * enabled CRITICAL or HIGH authentication keys (lib/auth/login-key.ts).
   * `fresh` reads the identity past the cache: the check that authorizes a
   * sign-in must see a key disabled moments ago.
   */
  async validatePrivateKey(
    privateKeyWif: string,
    identityId: string,
    network: 'testnet' | 'mainnet' = 'testnet',
    { fresh = false }: { fresh?: boolean } = {}
  ): Promise<LoginKeyResult> {
    const malformed = checkLoginKeyFormat(privateKeyWif, network)
    if (malformed) return malformed

    const identity = await identityService.getIdentity(identityId, { fresh })
    if (!identity) {
      return { isValid: false, error: 'Identity not found', errorType: 'IDENTITY_NOT_FOUND' }
    }
    return checkLoginKey(privateKeyWif, identity.publicKeys, network)
  }
}

export const keyValidationService = new KeyValidationService()
