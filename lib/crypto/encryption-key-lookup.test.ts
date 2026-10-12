import bs58 from 'bs58'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findAnchorEncryptionKey, findEncryptionKey, isBoundToContract } from './encryption-key-lookup'

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const APP = id(1)
const DASHPAY = id(2)

const unbound = { id: 1, type: 0, purpose: 1, data: 'aa' }
const dashpayBound = { id: 2, type: 0, purpose: 1, data: 'bb', contractBounds: { $type: 'singleContract', id: DASHPAY } }
const anchorOld = { id: 3, type: 0, purpose: 1, data: 'cc', contractBounds: { $type: 'singleContract', id: APP } }
const anchorNew = { id: 4, type: 0, purpose: 1, data: 'dd', contractBounds: { toJSON: () => ({ $type: 'singleContract', id: APP }) } }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isBoundToContract', () => {
  it('reads JSON and wasm bounds, singleContract only', () => {
    expect(isBoundToContract(anchorOld.contractBounds, APP)).toBe(true)
    expect(isBoundToContract(anchorNew.contractBounds, APP)).toBe(true)
    expect(isBoundToContract(dashpayBound.contractBounds, APP)).toBe(false)
    expect(isBoundToContract({ $type: 'contractGroup', id: APP }, APP)).toBe(false)
    expect(isBoundToContract(undefined, APP)).toBe(false)
  })
})

describe('findAnchorEncryptionKey', () => {
  it('takes the newest enabled anchor-bound secp256k1 key and nothing else', () => {
    expect(findAnchorEncryptionKey([unbound, dashpayBound, anchorOld, anchorNew], APP)?.id).toBe(4)
    expect(findAnchorEncryptionKey([unbound, dashpayBound, anchorOld, { ...anchorNew, disabledAt: 5 }], APP)?.id).toBe(3)
    expect(findAnchorEncryptionKey([unbound, dashpayBound], APP)).toBeUndefined()
    expect(findAnchorEncryptionKey([{ ...anchorOld, type: 2 }], APP)).toBeUndefined()
  })
})

describe('findEncryptionKey', () => {
  it('keeps the legacy rule on legacy builds', () => {
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', '')
    expect(findEncryptionKey([dashpayBound, unbound])?.id).toBe(2)
  })

  it('has no unbound fallback on App Connect builds', () => {
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', 'app-connect')
    vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_APP_ID', APP)
    vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_ID', id(3))
    vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER', id(4))
    vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS', APP)
    expect(findEncryptionKey([unbound, dashpayBound])).toBeUndefined()
    expect(findEncryptionKey([unbound, dashpayBound, anchorOld])?.id).toBe(3)
  })
})
