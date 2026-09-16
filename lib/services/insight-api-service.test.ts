import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPaymentVerificationUrl } from './insight-api-service'

const txid = '4408369deb53d9888a3f269efb8294b56b0b989891485d05b0278f9e1a7c050a'

afterEach(() => vi.unstubAllEnvs())

describe('payment verification links', () => {
  it.each(['mainnet', 'testnet', 'devnet'])('keeps mainnet Dash payments on mainnet in a %s deployment', (network) => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', network)
    expect(getPaymentVerificationUrl(txid, 'dash:XdZgS6gbprXuu2SpRgv2ygVL9FNqBrWAHJ'))
      .toBe(`https://insight.dash.org/insight/tx/${txid}`)
  })

  it.each(['mainnet', 'testnet'])('uses testnet for tdash payments in a %s deployment', (network) => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', network)
    expect(getPaymentVerificationUrl(txid, 'tdash:yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw'))
      .toBe(`https://insight.testnet.networks.dash.org/insight/tx/${txid}`)
  })

  it('opens devnet payments through the working Moutai explorer entry route', () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet')
    expect(getPaymentVerificationUrl(txid, 'TDASH:yVUvQLRm6SYfjT46KoozgAA5y3AaxHxSj8?amount=0.00001'))
      .toBe(`https://insight.moutai.networks.dash.org/#!/tx/${txid}`)
  })

  it.each(['bitcoin:bc1qexample', 'ethereum:0x123', 'address-without-scheme'])('does not send a %s payment to a Dash explorer', (uri) => {
    expect(getPaymentVerificationUrl(txid, uri)).toBeNull()
  })

  it.each([
    ['missing', `{ "txid": "${txid}" }`],
    ['null', '{ "paymentUri": null }'],
    ['number', '{ "paymentUri": 123 }'],
    ['boolean', '{ "paymentUri": false }'],
    ['object', '{ "paymentUri": {} }'],
    ['array', '{ "paymentUri": ["tdash:address"] }']
  ])('keeps transaction IDs unlinked for a %s payment URI in decoded order data', (_type, json) => {
    const payload = JSON.parse(json)
    expect(getPaymentVerificationUrl(txid, payload.paymentUri)).toBeNull()
  })
})
