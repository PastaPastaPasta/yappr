/**
 * Token transitions sign with the account's CRITICAL key: the session's own,
 * one held for the tab (a recovery phrase's, or one given earlier with "Keep
 * for this tab"), or one the step-up sheet asks for (lib/auth/critical-key.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'

const { claim, freeze, signedWith, session } = vi.hoisted(() => ({
  claim: vi.fn(),
  freeze: vi.fn(),
  signedWith: [] as string[],
  session: { record: null as { wif: string; fromPasskey: boolean } | null, wallet: false, signedIn: true as boolean, signOutDuringFetch: false, signOutAtSigner: false },
}))

const priv = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + seed) % 251 + 1)
const CRITICAL = privateKeyToWif(priv(1), 'testnet', true)
const HIGH = privateKeyToWif(priv(2), 'testnet', true)
const KEYS = vi.hoisted(() => [] as unknown[])

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ tokens: { claim, freeze }, identities: { fetch: async () => { if (session.signOutDuringFetch) session.signedIn = false; return { publicKeys: KEYS } } } }) }))
vi.mock('./identity-nonce', () => ({ withSdkSignedWrite: (_owner: string, _contract: string, write: () => Promise<unknown>) => write() }))
vi.mock('./signer-service', () => ({
  signerService: { createSignerFromWasmKey: (wif: string) => { signedWith.push(wif); if (session.signOutAtSigner) session.signedIn = false; return { signer: true, identityKey: true } } },
}))
vi.mock('../secure-storage', () => ({ getPrivateKeyRecord: () => session.record }))
vi.mock('@/lib/auth/signing-keys', () => ({
  SigningUnavailableError: class extends Error {},
  assertRawKeyCovers: async () => {},
  hasAppConnectSession: () => session.wallet,
  reportSigningFailure: async () => {},
  reportSigningSuccess: () => {},
  resolveSigningKey: async () => ({ wif: 'ring-wif', identityKey: {} }),
}))
vi.mock('../contract-topology', () => ({ starterGrantAmount: () => BigInt(100), yappIsLocked: () => false }))
vi.mock('@dashevo/wasm-sdk', () => ({ Identifier: class { constructor(readonly value: string) {} } }))

import { tokenService } from './token-service'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import {
  answerCriticalKeyRequest,
  cancelCriticalKeyRequest,
  currentCriticalKeyRequest,
  forgetCriticalKey,
  forgetCriticalKeysOnIdentityChange,
  holdCriticalKey,
  subscribeCriticalKeyRequests,
} from '@/lib/auth/critical-key'

const ME = 'Me11111111111111111111111111111111111111111'
const key = (id: number, seed: number, securityLevel: number) =>
  ({ id, type: KeyType.ECDSA_SECP256K1, purpose: KeyPurpose.AUTHENTICATION, securityLevel, data: bytesToBase64(getPublicKey(priv(seed))) })

let asked = 0
let reply: 'critical' | 'cancel' = 'critical'
let stopSheet: () => void
let unbind: () => void

beforeEach(() => {
  KEYS.splice(0, KEYS.length, key(1, 1, SecurityLevel.CRITICAL), key(2, 2, SecurityLevel.HIGH))
  claim.mockReset().mockResolvedValue(undefined)
  freeze.mockReset().mockResolvedValue(undefined)
  signedWith.length = 0
  session.record = { wif: HIGH, fromPasskey: false }
  session.wallet = false
  asked = 0
  reply = 'critical'
  session.signedIn = true
  session.signOutDuringFetch = false
  session.signOutAtSigner = false
  unbind = bindCurrentIdentity(() => (session.signedIn ? ME : null))
  stopSheet = subscribeCriticalKeyRequests(() => {
    const request = currentCriticalKeyRequest()
    if (!request) return
    asked++
    queueMicrotask(() => {
      if (reply === 'cancel') cancelCriticalKeyRequest(request)
      else answerCriticalKeyRequest(request, { wif: CRITICAL, source: 'typed', keep: false })
    })
  })
})

afterEach(() => {
  stopSheet()
  unbind()
  forgetCriticalKey(ME)
})

describe('the starter claim', () => {
  it('after a recovery-phrase sign-in that held the CRITICAL key, claims without asking', async () => {
    holdCriticalKey(ME, CRITICAL, 'phrase')
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: true })
    expect(asked).toBe(0)
    expect(signedWith).toEqual([CRITICAL])
  })

  it('from a HIGH session holding no CRITICAL key, asks, then claims with the key given', async () => {
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: true })
    expect(asked).toBe(1)
    expect(signedWith).toEqual([CRITICAL])
  })

  it('a session signed in with the CRITICAL key claims without asking', async () => {
    session.record = { wif: CRITICAL, fromPasskey: false }
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: true })
    expect(asked).toBe(0)
  })

  it('a moderator\'s CRITICAL key from a passkey is not used: the sheet asks for the key itself', async () => {
    session.record = { wif: CRITICAL, fromPasskey: true }
    await tokenService.claimStarterGrant(ME)
    expect(asked).toBe(1)
  })

  it('closing the sheet sends nothing', async () => {
    reply = 'cancel'
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: false, errorCode: 'CANCELLED' })
    expect(claim).not.toHaveBeenCalled()
  })

  it('after a sign-out, the held key is gone and the next claim asks again', async () => {
    const listeners: ((state: { user: { identityId: string } | null }) => void)[] = []
    const stop = forgetCriticalKeysOnIdentityChange({ user: { identityId: ME } }, (next) => { listeners.push(next); return () => {} })
    holdCriticalKey(ME, CRITICAL, 'phrase')
    for (const listener of listeners) listener({ user: null })
    await tokenService.claimStarterGrant(ME)
    expect(asked).toBe(1)
    stop()
  })

  it('a sign-out while the identity is read stops the claim, even for a session signed in with the CRITICAL key', async () => {
    session.record = { wif: CRITICAL, fromPasskey: false }
    session.signOutDuringFetch = true
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: false, errorCode: 'CANCELLED' })
    expect(claim).not.toHaveBeenCalled()
    expect(signedWith).toEqual([])
  })

  it('a sign-out after the signer is built, before the write goes out, sends nothing', async () => {
    session.record = { wif: CRITICAL, fromPasskey: false }
    session.signOutAtSigner = true
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: false, errorCode: 'CANCELLED' })
    expect(claim).not.toHaveBeenCalled()
  })

  it('a wallet session claims with its key ring, and a sign-out before the claim goes out sends nothing', async () => {
    session.wallet = true
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: true })
    expect(signedWith).toEqual(['ring-wif'])
    expect(asked).toBe(0)
    claim.mockClear()
    session.signOutAtSigner = true
    expect(await tokenService.claimStarterGrant(ME)).toEqual({ success: false, errorCode: 'CANCELLED' })
    expect(claim).not.toHaveBeenCalled()
  })

  it('a token authority action (freeze) takes the CRITICAL key too: held, or asked for from a HIGH session', async () => {
    holdCriticalKey(ME, CRITICAL, 'typed')
    expect(await tokenService.freeze(ME, 'Tgt1')).toEqual({ success: true })
    expect(asked).toBe(0)
    expect(signedWith).toEqual([CRITICAL])
    forgetCriticalKey(ME)
    expect(await tokenService.freeze(ME, 'Tgt1')).toEqual({ success: true })
    expect(asked).toBe(1)
    expect(signedWith).toEqual([CRITICAL, CRITICAL])
    reply = 'cancel'
    expect(await tokenService.freeze(ME, 'Tgt1')).toEqual({ success: false, errorCode: 'CANCELLED' })
    expect(freeze).toHaveBeenCalledTimes(2)
  })

  it('canSignTokenTransitions counts a held key, and not a HIGH session alone', async () => {
    expect(await tokenService.canSignTokenTransitions(ME)).toBe(false)
    holdCriticalKey(ME, CRITICAL, 'typed')
    expect(await tokenService.canSignTokenTransitions(ME)).toBe(true)
  })
})
