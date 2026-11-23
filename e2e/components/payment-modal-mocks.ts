// Stands in for the token, tip and nonce services in the payment-modal fixture: no
// transition is built or sent. Each wallet request built, each local payment and each
// balance or tip-history read goes through `paymentTest`, so a test can steer them.
import type { SentTipMatch } from '../../lib/services/tip-history-service'

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const state = {
  balance: BigInt(1000),
  live: true,
  builds: [] as { kind: 'purchase' | 'tip'; ownerId: string }[],
  localPayments: 0,
  balanceReads: 0,
  heldBalance: null as Deferred<bigint> | null,
  heldTipCheck: null as Deferred<{ success: boolean; error?: string }> | null,
}

declare global {
  interface Window {
    paymentTest: {
      state: typeof state
      holdNextBalance: () => void
      releaseBalance: (value: number) => void
      holdNextTipCheck: () => void
      releaseTipCheck: (success: boolean) => void
    }
  }
}

window.paymentTest = {
  state,
  holdNextBalance: () => { state.heldBalance = deferred() },
  releaseBalance: (value) => { state.heldBalance?.resolve(BigInt(value)); state.heldBalance = null },
  holdNextTipCheck: () => { state.heldTipCheck = deferred() },
  releaseTipCheck: (success) => { state.heldTipCheck?.resolve(success ? { success } : { success, error: 'Not found yet.' }); state.heldTipCheck = null },
}

const request = (kind: 'purchase' | 'tip', ownerId: string) => {
  state.builds.push({ kind, ownerId })
  return { bytes: new Uint8Array([kind === 'tip' ? 2 : 1, state.builds.length]), nonce: BigInt(100 + state.builds.length), discard: async () => {} }
}

export const MIN_YAPP_PURCHASE = BigInt(100)
export const tokenService = {
  getBalance: async (): Promise<bigint> => {
    state.balanceReads++
    return state.heldBalance ? state.heldBalance.promise : state.balance
  },
  getPricePerToken: async () => BigInt(1000),
  canSignTokenTransitions: async () => false,
  buyYapp: async () => {
    state.localPayments++
    return { success: false, error: 'Needs a key', errorCode: 'NEEDS_CRITICAL_KEY' }
  },
}

export const buildUnsignedDirectPurchaseTransition = async (ownerId: string) => request('purchase', ownerId)
export const buildUnsignedYappTipTransition = async (ownerId: string) => request('tip', ownerId)
export const walletRequestLive = async () => state.live

export const CREDITS_PER_DASH = 100_000_000_000
export const MIN_TIP_CREDITS = 100_000
export const tipService = {
  formatDash: (dash: number) => `${dash} DASH`,
  creditsToDash: (credits: number) => credits / CREDITS_PER_DASH,
  dashToCredits: (dash: number) => Math.round(dash * CREDITS_PER_DASH),
  validateYappTip: () => null,
  tipMatch: (recipientId: string, amount: bigint): SentTipMatch => ({ recipientId, amount } as unknown as SentTipMatch),
  tipNoteFor: () => undefined,
  confirmYappTip: async () => (state.heldTipCheck ? state.heldTipCheck.promise : { success: false, error: 'Not found yet.' }),
  sendYappTipLocal: async () => {
    state.localPayments++
    return { success: true }
  },
  sendTip: async () => ({ success: false, error: 'Not used here' }),
}

export const tipHistoryService = { getTipsSent: async () => [], clearCache: () => {} }
export const matchesSentTip = () => false
export const unifiedProfileService = { getPaymentUris: async () => [] }
