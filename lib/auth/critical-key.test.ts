import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bytesToBase64 } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { KeyPurpose, KeyType, SecurityLevel } from '@/lib/crypto/identity-keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { bindCurrentIdentity } from './active-identity'
import {
  CRITICAL_KEY_REQUIRED,
  CriticalKeyCancelledError,
  answerCriticalKeyRequest,
  availableCriticalKey,
  bindCriticalKeySession,
  cancelCriticalKeyRequest,
  criticalKeyFor,
  currentCriticalKeyRequest,
  forgetCriticalKey,
  forgetCriticalKeysOnIdentityChange,
  holdCriticalKey,
  subscribeCriticalKeyRequests,
  type CriticalKeyAnswer,
} from './critical-key'

const A = 'IdA1111111111111111111111111111111111111111'
const B = 'IdB1111111111111111111111111111111111111111'

const priv = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) % 251 + 1)
const wifOf = (seed: number) => privateKeyToWif(priv(seed), 'testnet', true)
const CRITICAL = wifOf(1)
const HIGH = wifOf(2)
const OTHER_CRITICAL = wifOf(3)

const key = (id: number, seed: number, securityLevel: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: KeyType.ECDSA_SECP256K1,
  purpose: KeyPurpose.AUTHENTICATION,
  securityLevel,
  data: bytesToBase64(getPublicKey(priv(seed))),
  ...extra,
})
const KEYS = [key(1, 1, SecurityLevel.CRITICAL), key(2, 2, SecurityLevel.HIGH)]
/** Identity B's keys: its own CRITICAL key, which A's key never matches. */
const B_KEYS = [key(1, 3, SecurityLevel.CRITICAL)]

/** A mounted sheet that records what it was asked and answers as told. */
function sheet(answer: (request: { identityId: string; use: string }) => CriticalKeyAnswer | null) {
  const asked: { identityId: string; use: string }[] = []
  const unsubscribe = subscribeCriticalKeyRequests(() => {
    const request = currentCriticalKeyRequest()
    if (!request) return
    asked.push({ identityId: request.identityId, use: request.use })
    queueMicrotask(() => {
      const reply = answer(request)
      if (reply) answerCriticalKeyRequest(request, reply)
      else cancelCriticalKeyRequest(request)
    })
  })
  return { asked, unsubscribe }
}

let signedIn: string | null = A
let unbind: () => void
let unmount: (() => void) | null = null

beforeEach(() => {
  signedIn = A
  unbind = bindCurrentIdentity(() => signedIn)
})

afterEach(() => {
  unmount?.()
  unmount = null
  forgetCriticalKey(A)
  forgetCriticalKey(B)
  unbind()
})

function mount(answer: Parameters<typeof sheet>[0]) {
  unmount?.()
  const mounted = sheet(answer)
  unmount = mounted.unsubscribe
  return mounted
}

describe('criticalKeyFor', () => {
  it('signs with a session that already holds the CRITICAL key, without asking', async () => {
    const { asked } = mount(() => null)
    const { wif, key: matched } = await criticalKeyFor(A, KEYS, 'moderation', CRITICAL)
    expect(wif).toBe(CRITICAL)
    expect(matched.id).toBe(1)
    expect(asked).toEqual([])
  })

  it('asks when the session signs with a HIGH key, and signs with the key given', async () => {
    const { asked } = mount(() => ({ wif: CRITICAL, source: 'typed', keep: false }))
    const { wif } = await criticalKeyFor(A, KEYS, 'moderation', HIGH)
    expect(wif).toBe(CRITICAL)
    expect(asked).toEqual([{ identityId: A, use: 'moderation' }])
  })

  it('kept for the tab, the key signs the next action without asking again', async () => {
    const { asked } = mount(() => ({ wif: CRITICAL, source: 'typed', keep: true }))
    await criticalKeyFor(A, KEYS, 'moderation', null)
    await criticalKeyFor(A, KEYS, 'moderation', null)
    expect(asked).toHaveLength(1)
  })

  it('not kept, the key signs that one action and the next one asks again', async () => {
    const { asked } = mount(() => ({ wif: CRITICAL, source: 'typed', keep: false }))
    await criticalKeyFor(A, KEYS, 'moderation', null)
    await criticalKeyFor(A, KEYS, 'moderation', null)
    expect(asked).toHaveLength(2)
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
  })

  it('closing the sheet stops the action', async () => {
    mount(() => null)
    await expect(criticalKeyFor(A, KEYS, 'moderation', null)).rejects.toBeInstanceOf(CriticalKeyCancelledError)
  })

  it('answers the marker where no sheet is mounted (the mobile engine), asking nobody', async () => {
    await expect(criticalKeyFor(A, KEYS, 'token', HIGH)).rejects.toThrow(CRITICAL_KEY_REQUIRED)
    expect(currentCriticalKeyRequest()).toBeNull()
  })

  it('never signs with a key that is not this identity\'s CRITICAL key, and never keeps it', async () => {
    mount(() => ({ wif: OTHER_CRITICAL, source: 'typed', keep: true }))
    await expect(criticalKeyFor(A, KEYS, 'moderation', null)).rejects.toThrow(CRITICAL_KEY_REQUIRED)
    mount(() => ({ wif: HIGH, source: 'typed', keep: true }))
    await expect(criticalKeyFor(A, KEYS, 'moderation', null)).rejects.toThrow(CRITICAL_KEY_REQUIRED)
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
  })

  it('a key held for one identity never signs for another', async () => {
    holdCriticalKey(A, CRITICAL, 'typed')
    expect(availableCriticalKey(B, B_KEYS, 'moderation', null)).toBeNull()
    expect(availableCriticalKey(B, KEYS, 'moderation', null)).toBeNull()
  })

  it('drops a held key the identity has disabled since, and asks', async () => {
    holdCriticalKey(A, CRITICAL, 'typed')
    const disabled = [key(1, 1, SecurityLevel.CRITICAL, { disabledAt: 5 }), key(4, 3, SecurityLevel.CRITICAL)]
    const { asked } = mount(() => ({ wif: OTHER_CRITICAL, source: 'typed', keep: false }))
    const { wif } = await criticalKeyFor(A, disabled, 'moderation', null)
    expect(wif).toBe(OTHER_CRITICAL)
    expect(asked).toHaveLength(1)
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
  })

  it('a passkey\'s CRITICAL key moderates but never signs a token transition', async () => {
    holdCriticalKey(A, CRITICAL, 'passkey')
    expect(availableCriticalKey(A, KEYS, 'moderation', null)?.wif).toBe(CRITICAL)
    expect(availableCriticalKey(A, KEYS, 'token', null)).toBeNull()
    mount(() => ({ wif: CRITICAL, source: 'passkey', keep: true }))
    await expect(criticalKeyFor(A, KEYS, 'token', null)).rejects.toThrow(CRITICAL_KEY_REQUIRED)
  })

  it('a recovery phrase\'s CRITICAL key, held at sign-in, signs a claim without asking', async () => {
    holdCriticalKey(A, CRITICAL, 'phrase')
    const { asked } = mount(() => null)
    expect((await criticalKeyFor(A, KEYS, 'token', HIGH)).wif).toBe(CRITICAL)
    expect(asked).toEqual([])
  })

  it('two actions waiting at once share one sheet', async () => {
    const { asked } = mount(() => ({ wif: CRITICAL, source: 'typed', keep: false }))
    const [first, second] = await Promise.all([criticalKeyFor(A, KEYS, 'moderation', null), criticalKeyFor(A, KEYS, 'moderation', null)])
    expect(first.wif).toBe(CRITICAL)
    expect(second.wif).toBe(CRITICAL)
    expect(asked).toHaveLength(1)
  })

  it('stops, signing nothing and keeping nothing, when the identity signed out while the sheet was open', async () => {
    mount(() => {
      signedIn = null
      return { wif: CRITICAL, source: 'typed', keep: true }
    })
    await expect(criticalKeyFor(A, KEYS, 'moderation', null)).rejects.toBeInstanceOf(CriticalKeyCancelledError)
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
  })

  it('never opens a sheet for an identity that is no longer the one signed in', async () => {
    signedIn = B
    const { asked } = mount(() => ({ wif: CRITICAL, source: 'typed', keep: true }))
    await expect(criticalKeyFor(A, KEYS, 'moderation', null)).rejects.toBeInstanceOf(CriticalKeyCancelledError)
    expect(asked).toEqual([])
  })

  it('a key held in an earlier session is never used in a later one (say, a wallet sign-in as the same identity)', () => {
    let epoch = 1
    const unbindSession = bindCriticalKeySession(() => epoch)
    holdCriticalKey(A, CRITICAL, 'phrase')
    expect(availableCriticalKey(A, KEYS, 'token', null)?.wif).toBe(CRITICAL)
    epoch = 2
    expect(availableCriticalKey(A, KEYS, 'token', null)).toBeNull()
    epoch = 1
    expect(availableCriticalKey(A, KEYS, 'token', null)).toBeNull()
    unbindSession()
  })

  it('a late answer from a sheet that was replaced never settles the request opened since', async () => {
    const stop = subscribeCriticalKeyRequests(() => {})
    const first = criticalKeyFor(A, KEYS, 'moderation', null)
    const shown = currentCriticalKeyRequest()
    // A token action replaces it while the first sheet is still checking its key.
    const second = criticalKeyFor(A, KEYS, 'token', null)
    await expect(first).rejects.toBeInstanceOf(CriticalKeyCancelledError)
    if (shown) answerCriticalKeyRequest(shown, { wif: CRITICAL, source: 'typed', keep: true })
    expect(currentCriticalKeyRequest()).toMatchObject({ identityId: A, use: 'token' })
    const open = currentCriticalKeyRequest()
    if (open) cancelCriticalKeyRequest(open)
    await expect(second).rejects.toBeInstanceOf(CriticalKeyCancelledError)
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
    stop()
  })

  it('unmounting the sheet closes the request it had open', async () => {
    const pending = criticalKeyFor(A, KEYS, 'moderation', null)
    // No sheet: refused at once. With one, then unmounted mid-request: cancelled.
    await expect(pending).rejects.toThrow(CRITICAL_KEY_REQUIRED)
    const stop = subscribeCriticalKeyRequests(() => {})
    const waiting = criticalKeyFor(A, KEYS, 'moderation', null)
    stop()
    await expect(waiting).rejects.toBeInstanceOf(CriticalKeyCancelledError)
  })
})

describe('forgetCriticalKeysOnIdentityChange', () => {
  type State = { user: { identityId: string } | null }

  function harness(initial: State) {
    let listener: ((state: State) => void) | null = null
    const stop = forgetCriticalKeysOnIdentityChange(initial, (next) => {
      listener = next
      return () => { listener = null }
    })
    return { emit: (state: State) => listener?.(state), stop }
  }

  it('forgets the held key on sign-out', () => {
    const { emit } = harness({ user: { identityId: A } })
    holdCriticalKey(A, CRITICAL, 'typed')
    emit({ user: null })
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
  })

  it('forgets the previous account\'s key on a switch, and keeps what the new sign-in stored', () => {
    const { emit } = harness({ user: { identityId: A } })
    holdCriticalKey(A, CRITICAL, 'typed')
    // A recovery-phrase sign-in as B holds B's key inside its commit, before the switch is published.
    holdCriticalKey(B, OTHER_CRITICAL, 'phrase')
    emit({ user: { identityId: B } })
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
    expect(availableCriticalKey(B, B_KEYS, 'token', null)?.wif).toBe(OTHER_CRITICAL)
  })

  it('keeps the key while the same identity stays signed in (balance and username refreshes)', () => {
    const { emit } = harness({ user: { identityId: A } })
    holdCriticalKey(A, CRITICAL, 'typed')
    emit({ user: { identityId: A } })
    expect(availableCriticalKey(A, KEYS, 'moderation', null)?.wif).toBe(CRITICAL)
  })

  it('closes a sheet open for the identity that signed out', async () => {
    const { emit } = harness({ user: { identityId: A } })
    const stop = subscribeCriticalKeyRequests(() => {})
    const waiting = criticalKeyFor(A, KEYS, 'moderation', null)
    expect(currentCriticalKeyRequest()).toMatchObject({ identityId: A, use: 'moderation' })
    emit({ user: null })
    await expect(waiting).rejects.toBeInstanceOf(CriticalKeyCancelledError)
    expect(currentCriticalKeyRequest()).toBeNull()
    stop()
  })

  it('forgetCriticalKey (a remote sign-out of this tab) drops the key and its open sheet', async () => {
    holdCriticalKey(A, CRITICAL, 'typed')
    forgetCriticalKey(A)
    expect(availableCriticalKey(A, KEYS, 'moderation', null)).toBeNull()
    const stop = subscribeCriticalKeyRequests(() => {})
    const waiting = criticalKeyFor(A, KEYS, 'moderation', null)
    forgetCriticalKey(A)
    await expect(waiting).rejects.toBeInstanceOf(CriticalKeyCancelledError)
    stop()
  })
})
