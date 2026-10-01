import { describe, expect, it } from 'vitest'
import { RemoteError, decode, encode, parse, serializeError, stringify } from '../../src/protocol/codec'

const roundTrip = <T>(value: T): T => parse(stringify(value)) as T

describe('codec', () => {
  it('passes plain JSON through untouched', () => {
    const value = { a: 1, b: 'two', c: [true, null, { d: 3.5 }] }
    expect(encode(value)).toEqual(value)
    expect(roundTrip(value)).toEqual(value)
  })

  it('round-trips Date, including an invalid one', () => {
    const date = new Date('2026-10-01T12:34:56.789Z')
    expect(roundTrip(date)).toEqual(date)
    expect(roundTrip(date)).toBeInstanceOf(Date)
    expect(Number.isNaN(roundTrip(new Date(Number.NaN)).getTime())).toBe(true)
  })

  it('round-trips Uint8Array, and carries other binary views as Uint8Array', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255])
    const back = roundTrip(bytes)
    expect(back).toBeInstanceOf(Uint8Array)
    expect(Array.from(back)).toEqual([0, 1, 2, 254, 255])
    expect(Array.from(roundTrip(new Uint16Array([0x0102])) as unknown as Uint8Array)).toEqual([0x02, 0x01])
    expect(Array.from(roundTrip(new Uint8Array([9, 8]).buffer) as unknown as Uint8Array)).toEqual([9, 8])
  })

  it('round-trips large byte arrays (chunked base64)', () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 256)
    expect(roundTrip(big)).toEqual(big)
  })

  it('round-trips bigint beyond Number precision', () => {
    const value = 2n ** 80n + 1n
    expect(roundTrip(value)).toBe(value)
    expect(roundTrip(-5n)).toBe(-5n)
  })

  it('round-trips Map and Set with non-string keys and nested special values', () => {
    const map = new Map<unknown, unknown>([[1, 'one'], ['k', new Date(0)], [5n, new Set([new Uint8Array([1])])]])
    const back = roundTrip(map)
    expect(back).toBeInstanceOf(Map)
    expect(back.get(1)).toBe('one')
    expect(back.get('k')).toEqual(new Date(0))
    const set = back.get(5n) as Set<Uint8Array>
    expect(set).toBeInstanceOf(Set)
    expect(Array.from([...set][0])).toEqual([1])
  })

  it('keeps undefined in arrays and as object values', () => {
    const back = roundTrip({ a: undefined, list: [1, undefined, 3] })
    expect('a' in back).toBe(true)
    expect(back.a).toBeUndefined()
    expect(back.list).toEqual([1, undefined, 3])
    expect(roundTrip(undefined)).toBeUndefined()
  })

  it('keeps NaN and infinities', () => {
    expect(roundTrip([Number.NaN, Infinity, -Infinity])).toEqual([Number.NaN, Infinity, -Infinity])
  })

  it('carries Errors with name, verbatim message, code and extra fields', () => {
    const error = Object.assign(new TypeError('grovedb: invalid proof: Quorum not found in cache'), {
      code: 40711, details: { id: new Uint8Array([7]) },
    })
    const back = roundTrip(error) as RemoteError
    expect(back).toBeInstanceOf(Error)
    expect(back).toBeInstanceOf(RemoteError)
    expect(back.name).toBe('TypeError')
    expect(back.message).toBe('grovedb: invalid proof: Quorum not found in cache')
    expect(back.code).toBe(40711)
    expect(Array.from((back.data?.details as { id: Uint8Array }).id)).toEqual([7])
    expect(back.remoteStack).toBeUndefined()
  })

  it('carries evo-sdk WasmSdkError, whose fields are prototype getters on a non-Error class', () => {
    // Shaped like the wasm-bindgen glue: no `extends Error`, getters only, a pointer as the one own field.
    class WasmSdkError {
      __wbg_ptr = 42
      get name() { return 'WasmSdkError' }
      get message() { return 'Document already exists' }
      get code() { return 40132 }
      get kind() { return 'Protocol' }
      get isRetriable() { return false }
    }
    const back = parse(stringify(new Error('outer', { cause: new WasmSdkError() }))) as RemoteError
    const cause = back.cause as RemoteError
    expect(cause).toBeInstanceOf(RemoteError)
    expect(cause).toMatchObject({ name: 'WasmSdkError', message: 'Document already exists', code: 40132, kind: 'Protocol', isRetriable: false })
    expect(cause.data).toBeUndefined()
  })

  it('survives getters that throw (a freed wasm error) and limits the cause chain', () => {
    const freed = { get message(): string { throw new Error('null pointer passed to rust') } }
    expect(serializeError(freed)).toEqual({ name: 'Error', message: '[object Object]' })
    let chain: Error = new Error('root')
    for (let i = 0; i < 10; i++) chain = new Error(`level ${i}`, { cause: chain })
    let depth = 0
    for (let node = serializeError(chain); node.cause; node = node.cause) depth++
    expect(depth).toBe(3)
  })

  it('includes the stack only when asked', () => {
    const back = parse(stringify(new Error('boom'), { includeStack: true })) as RemoteError
    expect(back.remoteStack).toContain('boom')
  })

  it('keeps a __proto__ key as data and never sets a prototype', () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as Record<string, unknown>
    const back = roundTrip(value)
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(back, '__proto__')).toBe(true)
    expect((back as { polluted?: boolean }).polluted).toBeUndefined()
    const tagLike = JSON.parse('{"__proto__": {"$t": "undef"}}') as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(roundTrip(tagLike), '__proto__')).toBe(true)
  })

  it('cannot be fooled by user data that looks like a tag', () => {
    const value = { $t: 'bytes', v: 'AAEC' }
    expect(roundTrip(value)).toEqual(value)
    expect(roundTrip([{ $t: 'undef' }])).toEqual([{ $t: 'undef' }])
  })

  it('sends class instances as their fields, honouring toJSON, and drops functions', () => {
    class Point { constructor(public x: number, public y: number) {} norm() { return 0 } }
    expect(roundTrip(new Point(1, 2))).toEqual({ x: 1, y: 2 })
    expect(roundTrip({ toJSON: () => 'custom' })).toBe('custom')
    expect(roundTrip({ f: () => 1, keep: 1 })).toEqual({ keep: 1 })
  })

  it('throws on cycles but allows shared references', () => {
    const shared = { n: 1 }
    expect(roundTrip({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => encode(cyclic)).toThrow(/cycle/)
  })

  it('rejects unknown tags', () => {
    expect(() => decode({ $t: 'nope', v: 1 })).toThrow(/unknown tag/)
  })
})
