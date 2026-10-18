import bs58check from 'bs58check'
import { describe, expect, it } from 'vitest'
import { isValidDashAddress, isValidPaymentAddress, parsePaymentUri, filterPaymentUris } from './payment-uri'

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
    expect(isValidPaymentAddress('ethereum:', 'pay-0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed@1?value=1')).toBe(true)
    expect(isValidPaymentAddress('lightning:', 'user@example.com')).toBe(true)
    expect(isValidPaymentAddress('bitcoin:', '  ')).toBe(false)
  })

  it.each([
    ['bitcoin:', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'],
    ['bitcoin:', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['bitcoin:', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ'],
    ['bitcoin:', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'],
    ['bitcoin:', '2MsLXsEGDDUgsgRwwzqQbPvr9MZRApVae6w'],
    ['litecoin:', 'LVg2kJoFNg45Nbpy53h7Fe1wKyeXVRhMH9'],
    ['litecoin:', 'ltc1qg82tlldsuv7el0lf8ueg8mv0fz5s8tsx4n9jxv'],
    ['dogecoin:', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
    ['bitcoincash:', 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
    ['zcash:', 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU'],
    ['ethereum:', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ['ethereum:', 'vitalik.eth'],
    ['monero:', `4${'A'.repeat(94)}`],
    ['solana:', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'],
    ['tron:', 'TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW'],
    ['polkadot:', '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5'],
    ['ripple:', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
    ['stellar:', `G${'A'.repeat(55)}`],
    ['stellar:', 'alice*example.com'],
    ['cardano:', `addr1${'q'.repeat(98)}`],
    ['lightning:', 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq'],
  ])('accepts a plausible %s destination %s', (scheme, address) => {
    expect(isValidPaymentAddress(scheme, address)).toBe(true)
  })

  it.each([
    ['bitcoin:', 'notanaddress'],
    ['bitcoin:', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT0'],
    ['bitcoin:', 'bc1qexampleb'],
    ['litecoin:', 'hello world'],
    ['ethereum:', 'pay-0x123@1'],
    ['ethereum:', '0xZZZeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ['monero:', '4short'],
    ['solana:', 'javascript:alert(1)'],
    ['tron:', 'XJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW'],
    ['ripple:', 'not-an-address'],
    ['stellar:', 'gabc'],
    ['cardano:', 'addr1short'],
    ['lightning:', 'hello'],
  ])('rejects an obviously invalid %s destination %s', (scheme, address) => {
    expect(isValidPaymentAddress(scheme, address)).toBe(false)
  })
})


describe('untrusted payment URIs (SEC-02)', () => {
  it.each([
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,SECURITY_QA',
    'vbscript:msgbox(1)', 'file:///etc/passwd', 'https://wallet.example/pay',
    'http://wallet.example/pay', 'unknown:recipient', '//wallet.example/pay',
    'dash:', 'dash:invalid', 'dash://XdZgS6gbprXuu2SpRgv2ygVL9FNqBrWAHJ',
    `dash:${testnetAddress}`, `tdash:${mainnetAddress}`, `dash:${mainnetAddress}#fragment`,
    `dash:${mainnetAddress}?message=bad%escape`, `dash:${mainnetAddress}?message=bad\nvalue`,
    'java\tscript:alert(1)', 'bitcoin:javascript:alert(1)',
  ])('rejects %j even with trusted-looking metadata', (uri) => {
    expect(parsePaymentUri({ scheme: 'dash:', label: 'Verified Dash payment', uri })).toBeNull()
  })

  it('canonicalizes the real scheme and ignores all stored label/scheme fields', () => {
    expect(parsePaymentUri({ scheme: 'dash:', label: 'Verified Dash payment',
      uri: '  BITCOIN:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?label=Dash  ' })).toEqual({
      scheme: 'bitcoin:', label: 'Bitcoin', uri: 'bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?label=Dash',
    })
  })

  it.each([null, 42, {}, { uri: 42 }, 'invalid JSON', '{}', '[null,42,{}]'])('handles malformed lists %j', (value) => {
    expect(filterPaymentUris(value)).toEqual([])
  })

  it('preserves supported destinations and optional encoded payment parameters', () => {
    const uri = `dash:${mainnetAddress}?amount=0.25&message=Thanks%20a%20lot`
    expect(filterPaymentUris(JSON.stringify([{ scheme: 'javascript:', label: 'Other', uri }]))).toEqual([
      { scheme: 'dash:', uri, label: 'Dash' },
    ])
    expect(isValidPaymentAddress('unknown:', 'recipient')).toBe(false)
  })
})
