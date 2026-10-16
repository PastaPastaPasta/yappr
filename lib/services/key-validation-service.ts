import { identityService } from './identity-service'
import { checkLoginKey, checkLoginKeyFormat, type LoginKeyResult } from '@/lib/auth/login-key'

class KeyValidationService {
  /**
   * Whether a typed-in private key may sign `identityId` in: one of its
   * enabled CRITICAL or HIGH authentication keys (lib/auth/login-key.ts).
   */
  async validatePrivateKey(
    privateKeyWif: string,
    identityId: string,
    network: 'testnet' | 'mainnet' = 'testnet'
  ): Promise<LoginKeyResult> {
    const malformed = checkLoginKeyFormat(privateKeyWif, network)
    if (malformed) return malformed

    const identity = await identityService.getIdentity(identityId)
    if (!identity) {
      return { isValid: false, error: 'Identity not found', errorType: 'IDENTITY_NOT_FOUND' }
    }
    return checkLoginKey(privateKeyWif, identity.publicKeys, network)
  }
}

export const keyValidationService = new KeyValidationService()
