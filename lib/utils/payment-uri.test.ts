import bs58check from 'bs58check'
import { describe, expect, it } from 'vitest'
import { isValidDashAddress, isValidPaymentAddress } from './payment-uri'

const mainnetAddress = 'XdZgS6gbprXuu2SpRgv2ygVL9FNqBrWAHJ'
const testnetAddress = 'yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw'
const mainnetScriptAddress = '7SVxdgcMR1HAUQrMbKTE7MrY4m3NmuyV5U'
const testnetScriptAddress = '8eWmb1WDYYfnviGcfaTBZjftxGpCwriip5'

describe('isValidDashAddress', () => {
  it.each([
    [mainnetAddress, 'mainnet'],
    [testnetAddress, 'testnet'],
    [mainnetScriptAddress, 'mainnet'],
    [testnetScriptAddress, 'testnet'],
  ] as const)('accepts a valid %s address on %s', (address, network) => {
    expect(isValidDashAddress(address, network)).toBe(true)
    expect(isValidDashAddress(address, network === 'mainnet' ? 'testnet' : 'mainnet')).toBe(false)
  })

  it.each(['', '  ', 'y123', 'not-an-address', `${testnetAddress.slice(0, -1)}x`])(
    'rejects malformed address %j', (address) => {
      expect(isValidDashAddress(address, 'testnet')).toBe(false)
    }
  )

  it('rejects another currency even when its Base58Check checksum is valid', () => {
    expect(isValidDashAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'mainnet')).toBe(false)
  })

  it.each([19, 21])('rejects a valid checksum with a %i-byte address hash', (hashLength) => {
    const address = bs58check.encode(Uint8Array.from([140, ...Array(hashLength).fill(1)]))
    expect(isValidDashAddress(address, 'testnet')).toBe(false)
  })

  it('allows surrounding whitespace', () => {
    expect(isValidDashAddress(` ${testnetAddress} `, 'testnet')).toBe(true)
  })
})

describe('isValidPaymentAddress', () => {
  it('enforces the payment URI network, including mixed-case schemes', () => {
    expect(isValidPaymentAddress('dash:', mainnetAddress)).toBe(true)
    expect(isValidPaymentAddress('TDASH:', testnetAddress)).toBe(true)
    expect(isValidPaymentAddress('dash:', testnetAddress)).toBe(false)
    expect(isValidPaymentAddress('tdash:', mainnetAddress)).toBe(false)
  })

  it('accepts valid Dash URI destinations with optional query parameters', () => {
    expect(isValidPaymentAddress('dash:', `${mainnetAddress}?amount=1.25&label=Test%20store`)).toBe(true)
    expect(isValidPaymentAddress('tdash:', `${testnetAddress}?message=Thanks`)).toBe(true)
  })

  it('still rejects invalid or wrong-network destinations when parameters are present', () => {
    expect(isValidPaymentAddress('tdash:', 'y123?amount=1')).toBe(false)
    expect(isValidPaymentAddress('tdash:', '?amount=1')).toBe(false)
    expect(isValidPaymentAddress('dash:', `${testnetAddress}?amount=1`)).toBe(false)
  })

  it('preserves non-Dash payment payload support', () => {
    expect(isValidPaymentAddress('bitcoin:', 'bc1qexample?amount=1')).toBe(true)
    expect(isValidPaymentAddress('ethereum:', 'pay-0x123@1?value=1')).toBe(true)
    expect(isValidPaymentAddress('lightning:', 'user@example.com')).toBe(true)
    expect(isValidPaymentAddress('bitcoin:', '  ')).toBe(false)
  })
})
