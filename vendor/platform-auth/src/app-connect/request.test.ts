import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import {
  AppConnectRequestError,
  base64urlDecode,
  base64urlEncode,
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
    const uri = buildAppConnectUri(request, 'testnet', 'https://yap.pr/connect?r=ab')
    expect(uri.startsWith('dash-key:')).toBe(true)
    expect(uri).toContain('?n=t&v=2&cb=https%3A%2F%2Fyap.pr%2Fconnect%3Fr%3Dab')
    const parsed = parseAppConnectUri(uri)
    expect(parsed.request).toEqual(request)
    expect(parsed.network).toBe('testnet')
    expect(parsed.callbackUrl).toBe('https://yap.pr/connect?r=ab')
  })

  it('round-trips through the dashpay://connect carrier on every network', () => {
    const request = yapprVectorRequest()
    for (const [network, id] of [['mainnet', 'm'], ['testnet', 't'], ['devnet', 'd']] as const) {
      const uri = buildAppConnectUri(request, network, 'https://yap.pr/connect?r=ab', 'dashpay')
      expect(uri.startsWith(`dashpay://connect?v=2&n=${id}&r=`)).toBe(true)
      expect(uri.endsWith('&cb=https%3A%2F%2Fyap.pr%2Fconnect%3Fr%3Dab')).toBe(true)
      const parsed = parseAppConnectUri(uri)
      expect(parsed.request).toEqual(request)
      expect(parsed.network).toBe(network)
      expect(parsed.callbackUrl).toBe('https://yap.pr/connect?r=ab')
    }
    expect(buildAppConnectUri(request, 'devnet', undefined, 'dashpay')).not.toContain('&cb=')
  })

  it('defaults to dash-key: off mainnet and dashpay:// on mainnet, and never emits dash-key: on mainnet', () => {
    const request = yapprVectorRequest()
    expect(buildAppConnectUri(request, 'testnet').startsWith('dash-key:')).toBe(true)
    expect(buildAppConnectUri(request, 'devnet').startsWith('dash-key:')).toBe(true)
    expect(buildAppConnectUri(request, 'mainnet').startsWith('dashpay://connect?')).toBe(true)
    expect(() => buildAppConnectUri(request, 'mainnet', undefined, 'dash-key')).toThrow(AppConnectRequestError)
  })

  it('refuses the dash-key: carrier when n=m', () => {
    const uri = buildAppConnectUri(yapprVectorRequest(), 'testnet').replace('n=t', 'n=m')
    expect(refusal(() => parseAppConnectUri(uri)).code).toBe('invalid')
  })

  it('accepts a differently-cased dashpay://connect URI, a single trailing slash and any parameter order', () => {
    const request = yapprVectorRequest()
    const uri = buildAppConnectUri(request, 'devnet', 'https://yap.pr/c', 'dashpay')
    const r = new URL(uri.replace('dashpay://', 'https://')).searchParams.get('r')!
    for (const variant of [
      uri.replace('dashpay://connect', 'DashPay://CONNECT'),
      uri.replace('connect?', 'connect/?'),
      `dashpay://connect?cb=${encodeURIComponent('https://yap.pr/c')}&r=${r}&n=d&v=2&extra=1`,
    ]) {
      expect(parseAppConnectUri(variant).request, variant).toEqual(request)
    }
  })

  it('refuses malformed dashpay://connect shapes', () => {
    const uri = buildAppConnectUri(yapprVectorRequest(), 'devnet', undefined, 'dashpay')
    const bad: Array<[string, string]> = [
      ['userinfo', uri.replace('//connect', '//u@connect')],
      ['port', uri.replace('//connect', '//connect:80')],
      ['fragment', `${uri}#x`],
      ['a path', uri.replace('connect?', 'connect/x?')],
      ['a double slash', uri.replace('connect?', 'connect//?')],
      ['another verb', uri.replace('//connect', '//sign')],
      ['no query', 'dashpay://connect'],
      ['no r', 'dashpay://connect?v=2&n=d'],
      ['a repeated v', `${uri}&v=2`],
      ['a repeated r', `${uri}&r=AA`],
      ['a repeated n', `${uri}&n=d`],
      ['a repeated cb', `${uri}&cb=a&cb=b`],
      ['padding in r', `${uri}=`],
    ]
    for (const [name, value] of bad) {
      expect(refusal(() => parseAppConnectUri(value)).code, name).toBe('invalid')
    }
    expect(refusal(() => parseAppConnectUri(uri.replace('v=2', 'v=3'))).code).toBe('unsupported')
    expect(refusal(() => parseAppConnectUri(uri.replace('v=2&', ''))).code).toBe('unsupported')
    expect(refusal(() => parseAppConnectUri(uri.replace('n=d', 'n=x'))).code).toBe('invalid')
  })

  it('enforces the dashpay://connect size limits', () => {
    const uri = buildAppConnectUri(yapprVectorRequest(), 'devnet', undefined, 'dashpay')
    expect(refusal(() => parseAppConnectUri(`${uri}&pad=${'a'.repeat(4096)}`)).message).toMatch(/URI is too long/)
    const long = 'A'.repeat(1367)
    expect(refusal(() => parseAppConnectUri(`dashpay://connect?v=2&n=d&r=${long}`)).message).toMatch(/request is too long/)
    // 1,366 characters is exactly 1,024 bytes, so the character cap implies the byte cap.
    expect(base64urlEncode(new Uint8Array(1024)).length).toBe(1366)
  })

  it('ignores an r parameter on the dash-key: carrier, where it is unknown', () => {
    const request = yapprVectorRequest()
    const uri = buildAppConnectUri(request, 'testnet')
    expect(parseAppConnectUri(`${uri}&r=1&r=2`).request).toEqual(request)
  })

  it('ignores unknown dashpay://connect parameters', () => {
    const request = yapprVectorRequest()
    const uri = buildAppConnectUri(request, 'devnet', undefined, 'dashpay')
    expect(parseAppConnectUri(`${uri}&utm=1&utm2=2`).request).toEqual(request)
  })

  it('ignores unknown optional (odd) TLVs', () => {
    const request = yapprVectorRequest()
    const bytes = withTlv(encodeAppConnectRequest(request), 0x07, [0xaa, 0xbb])
    expect(decodeAppConnectRequest(withTlv(bytes, 0x09, []))).toEqual(request)
  })

  it('accepts repeats of an unknown optional TLV', () => {
    const request = yapprVectorRequest()
    const bytes = withTlv(withTlv(encodeAppConnectRequest(request), 0x07, [1]), 0x07, [2])
    expect(decodeAppConnectRequest(bytes)).toEqual(request)
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

  it('only knows MODE = renew (absent means login)', () => {
    const renew = encodeAppConnectRequest(renewVectorRequest())
    // MODE sits just before the 10-byte CREATED_AT.
    const modeAt = renew.length - 10 - 3
    expect([...renew.subarray(modeAt, modeAt + 3)]).toEqual([0x05, 1, 1])
    const zero = renew.slice()
    zero[modeAt + 2] = 0
    expect(refusal(() => decodeAppConnectRequest(zero)).code).toBe('invalid')
  })

  it('keeps a leading BOM instead of stripping it', () => {
    const request = yapprVectorRequest()
    const labelled = { ...request, label: '\ufeffYappr' }
    expect(decodeAppConnectRequest(encodeAppConnectRequest(labelled)).label).toBe('\ufeffYappr')

    // A DashPay binding whose name is EF BB BF "profile" must not decode as "profile".
    const bytes = encodeAppConnectRequest(request)
    const nameAt = PROFILE_LEVEL_AT + 1 + 32 + 16
    expect(bytes[nameAt]).toBe(7)
    const spliced = Uint8Array.from([
      ...bytes.subarray(0, PROFILE_LEVEL_AT - 3),
      0x02, 61, ...bytes.subarray(PROFILE_LEVEL_AT - 1, nameAt), 10, 0xef, 0xbb, 0xbf,
      ...bytes.subarray(nameAt + 1),
    ])
    expect(refusal(() => decodeAppConnectRequest(spliced)).message).toMatch(/document type name/)
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
      ['a label with a bidi override', { ...request, label: 'Yappr\u202e' }],
      ['a label with a control character', { ...request, label: 'Yap\npr' }],
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

describe('canonical base64url', () => {
  it('matches RFC 4648 section 5 without padding', () => {
    const cases: Array<[number[], string]> = [
      [[], ''],
      [[0x66], 'Zg'],
      [[0x66, 0x6f], 'Zm8'],
      [[0x66, 0x6f, 0x6f], 'Zm9v'],
      [[0xfb, 0xff, 0xfe], '-__-'],
      [[0xff], '_w'],
    ]
    for (const [bytes, text] of cases) {
      expect(base64urlEncode(Uint8Array.from(bytes))).toBe(text)
      expect([...base64urlDecode(text)]).toEqual(bytes)
    }
  })

  it('round-trips every length', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 255)
      expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes)
    }
  })

  it('refuses padding, the standard alphabet, other characters, length 1 mod 4 and non-zero trailing bits', () => {
    for (const bad of ['Zg==', 'Zm8=', 'a+b-', 'a/bc', 'ab cd', 'ab\ncd', '\u00e9abc', 'A', 'Zm9vA', 'Zh', 'Zm9', 'Zm-']) {
      expect(() => base64urlDecode(bad), JSON.stringify(bad)).toThrow(AppConnectRequestError)
    }
  })
})
