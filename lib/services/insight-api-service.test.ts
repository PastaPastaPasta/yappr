import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPaymentVerificationUrl } from './insight-api-service'

const txid = '4408369deb53d9888a3f269efb8294b56b0b989891485d05b0278f9e1a7c050a'
const mainnetAddress = 'XdZgS6gbprXuu2SpRgv2ygVL9FNqBrWAHJ'
const testnetAddress = 'yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw'
const devnetAddress = 'yVUvQLRm6SYfjT46KoozgAA5y3AaxHxSj8'
/** The store's own payment list, as the seller page passes it. */
const store = (...uris: string[]) => uris.map((uri) => ({ uri }))

afterEach(() => vi.unstubAllEnvs())

describe('payment verification links', () => {
  it('links a mainnet store payment to the mainnet explorer on a mainnet build', () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet')
    expect(getPaymentVerificationUrl(txid, `dash:${mainnetAddress}`, store(`dash:${mainnetAddress}`)))
      .toBe(`https://insight.dash.org/insight/tx/${txid}`)
  })

  it('links dash: with a testnet address to testnet on a testnet build', () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'testnet')
    expect(getPaymentVerificationUrl(txid, `dash:${testnetAddress}`, store(`dash:${testnetAddress}`)))
      .toBe(`https://insight.testnet.networks.dash.org/insight/tx/${txid}`)
  })

  it('links dash: with a testnet address to the devnet a devnet deployment runs on', () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet')
    expect(getPaymentVerificationUrl(txid, `dash:${devnetAddress}`, store(`dash:${devnetAddress}`)))
      .toBe(`https://insight.moutai.networks.dash.org/#!/tx/${txid}`)
  })

  it.each(['mainnet', 'testnet'])('uses testnet for tdash payments in a %s deployment', (network) => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', network)
    expect(getPaymentVerificationUrl(txid, `tdash:${testnetAddress}`, store(`tdash:${testnetAddress}`)))
      .toBe(`https://insight.testnet.networks.dash.org/insight/tx/${txid}`)
  })

  it('opens devnet payments through the working Moutai explorer entry route, ignoring the amount', () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet')
    expect(getPaymentVerificationUrl(txid, `TDASH:${devnetAddress}?amount=0.00001`, store(`tdash:${devnetAddress}`)))
      .toBe(`https://insight.moutai.networks.dash.org/#!/tx/${txid}`)
  })

  it('links nothing when the buyer names an address that is not the store\'s', () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'testnet')
    expect(getPaymentVerificationUrl(txid, `dash:${devnetAddress}`, store(`dash:${testnetAddress}`))).toBeNull()
    expect(getPaymentVerificationUrl(txid, `dash:${testnetAddress}`, [])).toBeNull()
  })

  it('links nothing when the buyer\'s URI claims the other network', () => {
    // A testnet build: a mainnet address under dash: does not parse, whatever the store lists.
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'testnet')
    expect(getPaymentVerificationUrl(txid, `dash:${mainnetAddress}`, store(`dash:${mainnetAddress}`))).toBeNull()
  })

  it.each(['bitcoin:bc1qexample', 'ethereum:0x123', 'address-without-scheme'])('does not send a %s payment to a Dash explorer', (uri) => {
    expect(getPaymentVerificationUrl(txid, uri, store(uri))).toBeNull()
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
    expect(getPaymentVerificationUrl(txid, payload.paymentUri, store(`tdash:${testnetAddress}`))).toBeNull()
  })
})
