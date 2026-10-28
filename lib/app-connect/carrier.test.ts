import { describe, expect, it } from 'vitest'
import { selectCarrierUri, type AppConnectCarrierUris } from './carrier'

const both: AppConnectCarrierUris = [
  { carrier: 'dash-key', uri: 'dash-key:abc?n=t&v=2' },
  { carrier: 'dashpay', uri: 'dashpay://connect?v=2&n=t&r=abc' },
]

describe('selectCarrierUri', () => {
  it('defaults to the first carrier, dash-key: where both are offered', () => {
    expect(selectCarrierUri(both, null)).toBe(both[0])
  })

  it('picks the wanted carrier when the request has it', () => {
    expect(selectCarrierUri(both, 'dashpay')).toBe(both[1])
    expect(selectCarrierUri(both, 'dash-key')).toBe(both[0])
  })

  it('falls back to the only carrier a single-carrier build has', () => {
    const only: AppConnectCarrierUris = [both[1]]
    expect(selectCarrierUri(only, 'dash-key')).toBe(both[1])
    expect(selectCarrierUri(only, null)).toBe(both[1])
  })
})
