import { describe, expect, it } from 'vitest'
import { quorumServiceOrigin } from '../../src/preconnect'

describe('quorumServiceOrigin', () => {
  it('is wasm-sdk’s default quorum service on testnet and mainnet', () => {
    expect(quorumServiceOrigin('testnet')).toBe('https://quorums.testnet.networks.dash.org')
    expect(quorumServiceOrigin('mainnet')).toBe('https://quorums.mainnet.networks.dash.org')
  })

  it('is an origin on a devnet', () => {
    expect(quorumServiceOrigin('devnet')).toMatch(/^https:\/\/[^/]+$/)
  })
})
