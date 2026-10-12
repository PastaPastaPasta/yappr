import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { describe, expect, it } from 'vitest'
import { KeySecurityLevel, decodeAppConnectRequest, encodeAppConnectRequest } from 'platform-auth'
import { DASHPAY_CONTRACT_ID } from './config'
import { appConnectCallbackUrl, buildYapprAppConnectRequest } from './yappr-request'

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const pins = { appId: id(1), groupId: id(2), groupOwner: id(3), members: [{ contractId: id(1), version: 1 }] }
const createdAt = 1_791_676_800_000
const ninetyDays = 90 * 24 * 60 * 60_000

function build(identityHint?: string) {
  return buildYapprAppConnectRequest({
    pins,
    appEphemeralPubKey: secp256k1.getPublicKey(new Uint8Array(32).fill(7), true),
    connectionId: new Uint8Array(16).fill(9),
    createdAt,
    identityHint,
  })
}

describe('buildYapprAppConnectRequest', () => {
  it('asks for the CRITICAL group key, the DashPay profile key and the anchor encryption key', () => {
    const request = build()
    const [group, profile] = request.authBindings
    expect(group).toMatchObject({ kind: 'contractGroup', securityLevel: KeySecurityLevel.CRITICAL, totalBudget: 50_000_000_000n, expiresAt: createdAt + ninetyDays })
    expect(bs58.encode(group.id)).toBe(pins.groupId)
    expect(profile).toMatchObject({ kind: 'documentType', documentTypeName: 'profile', securityLevel: KeySecurityLevel.HIGH, totalBudget: 1_000_000_000n, expiresAt: createdAt + ninetyDays })
    expect(bs58.encode(profile.id)).toBe(DASHPAY_CONTRACT_ID)
    expect(request.encBindings.map((binding) => bs58.encode(binding.contractId))).toEqual([pins.appId])
    expect(request.identityHint).toBeUndefined()
    expect(request.mode).toBeUndefined()
  })

  it('round-trips through the v2 codec, with a hint for renewal', () => {
    const hinted = build(id(5))
    const decoded = decodeAppConnectRequest(encodeAppConnectRequest(hinted))
    expect(bs58.encode(decoded.identityHint as Uint8Array)).toBe(id(5))
    expect(decoded.connectionId).toEqual(new Uint8Array(16).fill(9))
    expect(decoded.authBindings).toHaveLength(2)
  })
})

describe('appConnectCallbackUrl', () => {
  it('builds the /connect link under the base path, https only', () => {
    expect(appConnectCallbackUrl('https://yap.pr', '/devnet', 'ab12')).toBe('https://yap.pr/devnet/connect/?r=ab12')
    expect(appConnectCallbackUrl('https://yap.pr', '', 'ab12')).toBe('https://yap.pr/connect/?r=ab12')
    expect(appConnectCallbackUrl('http://localhost:3000', '/testing', 'ab12')).toBeUndefined()
  })
})
