import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'

const { getIdentity } = vi.hoisted(() => ({ getIdentity: vi.fn() }))
vi.mock('./identity-service', () => ({ identityService: { getIdentity } }))
import { keyValidationService } from './key-validation-service'

const PRIV = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WIF = privateKeyToWif(PRIV, 'testnet')
const authKey = (disabledAt?: number) => ({
  id: 1, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.AUTHENTICATION, securityLevel: SecurityLevel.HIGH,
  data: bytesToBase64(getPublicKey(PRIV)), ...(disabledAt !== undefined ? { disabledAt } : {}),
})

describe('keyValidationService.validatePrivateKey', () => {
  beforeEach(() => getIdentity.mockReset())

  it('reads the identity fresh when asked, so a key disabled since the form checked it is refused (#616)', async () => {
    // The cached copy still shows the key enabled; chain now has it disabled.
    getIdentity.mockImplementation(async (_id: string, { fresh = false } = {}) => ({ id: 'alice', publicKeys: [authKey(fresh ? 7 : undefined)] }))

    expect(await keyValidationService.validatePrivateKey(WIF, 'alice', 'testnet')).toMatchObject({ isValid: true })
    expect(await keyValidationService.validatePrivateKey(WIF, 'alice', 'testnet', { fresh: true })).toMatchObject({ isValid: false, errorType: 'DISABLED' })
    expect(getIdentity).toHaveBeenLastCalledWith('alice', { fresh: true })
  })

  it('refuses a malformed key without reading the identity', async () => {
    expect(await keyValidationService.validatePrivateKey('nope', 'alice', 'testnet')).toMatchObject({ isValid: false, errorType: 'INVALID_WIF' })
    expect(getIdentity).not.toHaveBeenCalled()
  })
})
