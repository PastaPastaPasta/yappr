import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ identities: { contractNonce: vi.fn() } }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
})

import { YAPPR_CONTRACT_ID } from '../constants'
import { WALLET_TOKEN_SCOPE, reserveNonce } from './identity-nonce'
import { checkPurchaseRequest, checkShownRequest, clearShownRequest, heldRequestMessage, loadShownRequest, saveShownRequest, type ShownPaymentRequest } from './wallet-payment-request'

const OWNER = 'owner'
const n = (value: number) => BigInt(value)

const tip: ShownPaymentRequest = {
  key: 'tip:a',
  uri: 'dash-st:tip',
  nonce: n(101),
  description: '5 YAPP to alice',
  tip: { to: 'alice', amount: n(5), postId: 'post', message: '12n', since: 1000 },
}
const purchase: ShownPaymentRequest = {
  key: 'purchase:100',
  uri: 'dash-st:buy',
  nonce: n(101),
  description: '0.0100 DASH to buy 100 YAPP',
  purchase: { balanceBefore: n(40), amount: n(100) },
}

beforeEach(() => {
  storage.clear()
  sdk.identities.contractNonce.mockReset()
})

describe('the wallet payment request this browser showed (#929)', () => {
  it.each([tip, purchase])('keeps $key with its nonce and its proof', request => {
    saveShownRequest(OWNER, request)
    expect(loadShownRequest(OWNER)).toEqual(request)
  })

  it('says which payment is holding a new one back', () => {
    expect(heldRequestMessage(tip)).toBe('You have an unpaid payment request open. Pay it in your wallet first; it was for 5 YAPP to alice.')
  })

  it('shows the same QR again, or holds a different payment back, while its nonce may still execute', async () => {
    reserveNonce(OWNER, YAPPR_CONTRACT_ID, n(101), n(100), WALLET_TOKEN_SCOPE)
    saveShownRequest(OWNER, purchase)
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    expect(await checkShownRequest(OWNER, purchase.key)).toEqual({ kind: 'same', request: purchase })
    expect(await checkShownRequest(OWNER, tip.key)).toEqual({ kind: 'held', request: purchase })
  })

  it('hands back a request whose nonce can no longer execute for its proof, and drops another payment\'s', async () => {
    reserveNonce(OWNER, YAPPR_CONTRACT_ID, n(101), n(100), WALLET_TOKEN_SCOPE)
    saveShownRequest(OWNER, purchase)
    sdk.identities.contractNonce.mockResolvedValue(n(101))
    expect(await checkShownRequest(OWNER, purchase.key)).toEqual({ kind: 'settled', request: purchase })
    expect(loadShownRequest(OWNER)).toEqual(purchase)
    expect(await checkShownRequest(OWNER, tip.key)).toEqual({ kind: 'none' })
    expect(loadShownRequest(OWNER)).toBeNull()
  })

  describe('a purchase whose request can no longer execute', () => {
    beforeEach(() => {
      reserveNonce(OWNER, YAPPR_CONTRACT_ID, n(101), n(100), WALLET_TOKEN_SCOPE)
      saveShownRequest(OWNER, purchase)
      sdk.identities.contractNonce.mockResolvedValue(n(101))
    })

    it('is paid once a balance read, retried past a node that is behind, shows it', async () => {
      const balance = vi.fn<() => Promise<bigint>>().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(n(90)).mockResolvedValue(n(140))
      expect(await checkPurchaseRequest(OWNER, purchase.key, balance, { delayMs: 0 })).toEqual({ kind: 'paid', balance: n(140) })
      expect(balance).toHaveBeenCalledTimes(3)
    })

    it('builds nothing new while unproven, until the user clears it to buy again', async () => {
      // Paid, then 50 YAPP spent: the balance alone can't tell.
      const balance = vi.fn<() => Promise<bigint>>().mockResolvedValue(n(90))
      expect(await checkPurchaseRequest(OWNER, purchase.key, balance, { delayMs: 0 })).toEqual({ kind: 'unproven' })
      expect(balance).toHaveBeenCalledTimes(5)
      expect(await checkPurchaseRequest(OWNER, purchase.key, balance, { delayMs: 0 })).toEqual({ kind: 'unproven' })
      expect(loadShownRequest(OWNER)).toEqual(purchase)
      clearShownRequest(OWNER, purchase.key)
      expect(await checkPurchaseRequest(OWNER, purchase.key, balance, { delayMs: 0 })).toEqual({ kind: 'none' })
    })
  })

  it('reads nothing from Platform when no request is stored', async () => {
    expect(await checkShownRequest(OWNER, tip.key)).toEqual({ kind: 'none' })
    expect(sdk.identities.contractNonce).not.toHaveBeenCalled()
  })

  it('clears only the request it names', () => {
    saveShownRequest(OWNER, tip)
    clearShownRequest(OWNER, purchase.key)
    expect(loadShownRequest(OWNER)).toEqual(tip)
    clearShownRequest(OWNER, tip.key)
    expect(loadShownRequest(OWNER)).toBeNull()
  })
})
