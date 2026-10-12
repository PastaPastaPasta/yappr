import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import {
  AppConnectRequestError,
  buildAppConnectUri,
  checkAppConnectRequestAge,
  decodeAppConnectRequest,
  encodeAppConnectRequest,
  parseAppConnectUri,
  type AppConnectRequest,
} from './request'
import { KeySecurityLevel } from './types'
import { VECTOR_CREATED_AT, renewVectorRequest, yapprVectorRequest } from './test-helpers'

function refusal(fn: () => unknown): AppConnectRequestError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppConnectRequestError) return error
    throw error
  }
  throw new Error('expected an AppConnectRequestError')
}

// Layout of the Yappr vector request: a 72-byte header (version, key, app id,
// label "Yappr"), the group AUTH_BINDING TLV at 72 (52 bytes), the DashPay
// profile AUTH_BINDING at 124 (60 bytes), CONNECTION_ID at 184, ENC_BINDING
// at 202 (184 without a connection id) and CREATED_AT last.
const GROUP_KIND_AT = 74
const PROFILE_LEVEL_AT = 127
const CONNECTION_ID_AT = 184

function withTlv(bytes: Uint8Array, type: number, value: number[]): Uint8Array {
  return Uint8Array.from([...bytes, type, value.length, ...value])
}

describe('App Connect request v2 codec', () => {
  it('round-trips the Yappr request and the renew request', () => {
    for (const request of [yapprVectorRequest(), renewVectorRequest()]) {
      expect(decodeAppConnectRequest(encodeAppConnectRequest(request))).toEqual(request)
    }
  })

  it('round-trips through the URI with network and callback', () => {
    const request = yapprVectorRequest()
    const uri = buildAppConnectUri(request, 'mainnet', 'https://yap.pr/connect?r=ab')
    expect(uri.startsWith('dash-key:')).toBe(true)
    expect(uri).toContain('?n=m&v=2&cb=https%3A%2F%2Fyap.pr%2Fconnect%3Fr%3Dab')
    const parsed = parseAppConnectUri(uri)
    expect(parsed.request).toEqual(request)
    expect(parsed.network).toBe('mainnet')
    expect(parsed.callbackUrl).toBe('https://yap.pr/connect?r=ab')
  })

  it('ignores unknown optional (odd) TLVs', () => {
    const request = yapprVectorRequest()
    const bytes = withTlv(encodeAppConnectRequest(request), 0x07, [0xaa, 0xbb])
    expect(decodeAppConnectRequest(withTlv(bytes, 0x09, []))).toEqual(request)
  })

  it('refuses unknown mandatory (even) TLVs as unsupported', () => {
    const bytes = withTlv(encodeAppConnectRequest(yapprVectorRequest()), 0x08, [0x01])
    expect(refusal(() => decodeAppConnectRequest(bytes)).code).toBe('unsupported')
  })

  it('refuses an unknown binding kind as unsupported', () => {
    const tampered = encodeAppConnectRequest(yapprVectorRequest())
    tampered[GROUP_KIND_AT] = 7
    expect(refusal(() => decodeAppConnectRequest(tampered)).code).toBe('unsupported')
  })

  it('refuses every truncation', () => {
    const bytes = encodeAppConnectRequest(yapprVectorRequest())
    for (let length = 0; length < bytes.length; length++) {
      expect(() => decodeAppConnectRequest(bytes.subarray(0, length)), `length ${length}`).toThrow(AppConnectRequestError)
    }
  })

  it('refuses a v1 body and a v1 URI as unsupported', () => {
    const bytes = encodeAppConnectRequest(yapprVectorRequest())
    bytes[0] = 1
    expect(refusal(() => decodeAppConnectRequest(bytes)).code).toBe('unsupported')
    const uri = buildAppConnectUri(yapprVectorRequest(), 'testnet').replace('&v=2', '&v=1')
    expect(refusal(() => parseAppConnectUri(uri)).code).toBe('unsupported')
  })

  it('refuses TLVs out of order and repeated singletons', () => {
    const base = encodeAppConnectRequest(yapprVectorRequest())
    // A second CREATED_AT after the first.
    expect(refusal(() => decodeAppConnectRequest(withTlv(base, 0x06, [0, 0, 1, 0x99, 0, 0, 0, 0]))).code).toBe('invalid')
    // An IDENTITY_HINT after CREATED_AT.
    expect(refusal(() => decodeAppConnectRequest(withTlv(base, 0x01, Array(32).fill(1)))).code).toBe('invalid')
  })

  it('refuses known TLVs with the wrong length', () => {
    const bytes = encodeAppConnectRequest({ ...yapprVectorRequest(), connectionId: undefined })
    const at = CONNECTION_ID_AT
    const spliced = Uint8Array.from([...bytes.subarray(0, at), 0x03, 15, ...Array(15).fill(0), ...bytes.subarray(at)])
    expect(refusal(() => decodeAppConnectRequest(spliced)).code).toBe('invalid')
  })

  it('requires CREATED_AT', () => {
    const bytes = encodeAppConnectRequest(yapprVectorRequest())
    expect(refusal(() => decodeAppConnectRequest(bytes.subarray(0, bytes.length - 10))).code).toBe('invalid')
  })

  it('enforces binding rules on encode and decode', () => {
    const request = yapprVectorRequest()
    const [group, profile] = request.authBindings
    const cases: Array<[string, AppConnectRequest]> = [
      ['CRITICAL on a documentType binding', { ...request, authBindings: [group, { ...profile, securityLevel: KeySecurityLevel.CRITICAL }] }],
      ['MASTER on a group binding', { ...request, authBindings: [{ ...group, securityLevel: KeySecurityLevel.MASTER }] }],
      ['MEDIUM on a group binding', { ...request, authBindings: [{ ...group, securityLevel: KeySecurityLevel.MEDIUM }] }],
      ['a group binding without a budget', { ...request, authBindings: [{ ...group, totalBudget: undefined }] }],
      ['a documentType binding without a name', { ...request, authBindings: [{ ...profile, documentTypeName: undefined }] }],
      ['a bad document type name', { ...request, authBindings: [{ ...profile, documentTypeName: 'pro file' }] }],
      ['a name on a group binding', { ...request, authBindings: [{ ...group, documentTypeName: 'post' }] }],
      ['no auth bindings', { ...request, authBindings: [] }],
      ['five auth bindings', { ...request, authBindings: [group, profile, { ...profile, documentTypeName: 'a' }, { ...profile, documentTypeName: 'b' }, { ...profile, documentTypeName: 'c' }] }],
      ['duplicate auth bindings', { ...request, authBindings: [group, group] }],
      ['an encryption binding with the AUTHENTICATION purpose', { ...request, encBindings: [{ contractId: request.appId, purpose: 0 }] }],
      ['a short identity hint', { ...request, identityHint: new Uint8Array(31) }],
      ['a long label', { ...request, label: 'x'.repeat(65) }],
      ['an inherited property as the binding kind', { ...request, authBindings: [{ ...group, kind: 'toString' as 'contractGroup' }] }],
      ['an invalid ephemeral key', { ...request, appEphemeralPubKey: Uint8Array.of(2, ...Array(32).fill(0xff)) }],
    ]
    for (const [name, bad] of cases) {
      expect(() => encodeAppConnectRequest(bad), name).toThrow(AppConnectRequestError)
    }

    // The decoder applies the same rules to bytes a lax encoder produced.
    const tampered = encodeAppConnectRequest(request)
    expect(tampered[PROFILE_LEVEL_AT]).toBe(KeySecurityLevel.HIGH)
    tampered[PROFILE_LEVEL_AT] = KeySecurityLevel.CRITICAL
    expect(refusal(() => decodeAppConnectRequest(tampered)).message).toMatch(/security level 1/)
  })

  it('checks the URI query', () => {
    const uri = buildAppConnectUri(yapprVectorRequest(), 'devnet')
    expect(parseAppConnectUri(uri).network).toBe('devnet')
    expect(refusal(() => parseAppConnectUri(uri.replace('n=d', 'n=x'))).code).toBe('invalid')
    expect(refusal(() => parseAppConnectUri(`${uri}&v=2`)).code).toBe('invalid')
    expect(refusal(() => parseAppConnectUri(`${uri}&cb=${encodeURIComponent('http://yap.pr/connect')}`)).code).toBe('invalid')
    expect(refusal(() => parseAppConnectUri(`${uri}&cb=${encodeURIComponent('https://u:p@yap.pr/')}`)).code).toBe('invalid')
    expect(() => buildAppConnectUri(yapprVectorRequest(), 'devnet', 'javascript:alert(1)')).toThrow(AppConnectRequestError)
    expect(refusal(() => parseAppConnectUri(uri.replace('dash-key:', 'dash-key:0OIl'))).code).toBe('invalid')
  })

  it('applies the wallet freshness window', () => {
    expect(checkAppConnectRequestAge(VECTOR_CREATED_AT, VECTOR_CREATED_AT + 10 * 60_000)).toBeNull()
    expect(checkAppConnectRequestAge(VECTOR_CREATED_AT, VECTOR_CREATED_AT + 10 * 60_000 + 1)).toBe('stale')
    expect(checkAppConnectRequestAge(VECTOR_CREATED_AT, VECTOR_CREATED_AT - 2 * 60_000)).toBeNull()
    expect(checkAppConnectRequestAge(VECTOR_CREATED_AT, VECTOR_CREATED_AT - 2 * 60_000 - 1)).toBe('future')
  })

  it('carries ids as raw bytes', () => {
    const request = yapprVectorRequest()
    const decoded = decodeAppConnectRequest(encodeAppConnectRequest(request))
    expect(bs58.encode(decoded.authBindings[1].id)).toBe('Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7')
  })
})
