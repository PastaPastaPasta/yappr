import { describe, expect, it } from 'vitest'
import { checkLinkRows, checkTipRows, normalizeWebsite, splitPaymentUri, tipRowFromUri } from './edit-rows'

const testnetAddress = 'yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw'
const bitcoinAddress = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'
const label = (value: string) => value.replace(':', '')

describe('splitPaymentUri', () => {
  it('splits a pasted URI on an approved scheme, case-insensitively', () => {
    expect(splitPaymentUri(` BITCOIN:${bitcoinAddress} `)).toEqual({ scheme: 'bitcoin:', address: bitcoinAddress })
  })

  it('leaves bare addresses and unknown schemes alone', () => {
    expect(splitPaymentUri(testnetAddress)).toBeNull()
    expect(splitPaymentUri('https://example.com')).toBeNull()
  })
})

describe('tipRowFromUri', () => {
  it('keeps the fallback scheme for a value without one', () => {
    expect(tipRowFromUri(`tdash:${testnetAddress}`, 'dash:')).toEqual({ scheme: 'tdash:', address: testnetAddress })
    expect(tipRowFromUri(testnetAddress, 'tdash:')).toEqual({ scheme: 'tdash:', address: testnetAddress })
  })
})

describe('checkTipRows', () => {
  it('keeps valid addresses, drops blank rows and flags bad and repeated ones', () => {
    const result = checkTipRows([
      { scheme: 'tdash:', address: ` ${testnetAddress} ` },
      { scheme: 'bitcoin:', address: '' },
      { scheme: 'bitcoin:', address: 'nope' },
      { scheme: 'tdash:', address: testnetAddress },
    ], label)
    expect(result.values).toEqual([`tdash:${testnetAddress}`])
    expect(result.errors).toEqual([null, null, "That doesn't look like a bitcoin address", 'Already added'])
  })
})

describe('checkLinkRows', () => {
  it('trims handles, drops blank rows and flags invalid and repeated links', () => {
    const result = checkLinkRows([
      { platform: 'github', handle: ' octocat ' },
      { platform: 'email', handle: '   ' },
      { platform: 'email', handle: 'not-an-email' },
      { platform: 'github', handle: 'octocat' },
    ], label)
    expect(result.values).toEqual([{ platform: 'github', handle: 'octocat' }])
    expect(result.errors).toEqual([null, null, 'Invalid email address', 'This link is already added'])
  })
})

describe('normalizeWebsite', () => {
  it('adds https:// to a bare domain and keeps explicit schemes', () => {
    expect(normalizeWebsite(' example.com ')).toBe('https://example.com')
    expect(normalizeWebsite('http://example.com')).toBe('http://example.com')
    expect(normalizeWebsite('')).toBe('')
  })

  it('leaves the value alone when the scheme would not fit', () => {
    expect(normalizeWebsite('a'.repeat(195), 200)).toBe('a'.repeat(195))
  })
})
