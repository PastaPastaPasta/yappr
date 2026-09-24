import { describe, expect, it } from 'vitest'
import { ByteReader, concat, dmHkdf, kdfInfo, s16, u32, u64, weekOf, weekStart } from './kdf'
import { hex, key32 } from './test-fixtures'

describe('HKDF encoding', () => {
  it('builds info as label || NUL || fields', () => {
    expect(hex(kdfInfo('tag', u32(1), u32(2)))).toBe('746167000000000100000002')
    expect(hex(kdfInfo('self'))).toBe('73656c6600')
  })

  it('matches a fixed vector (HKDF-SHA256, salt "yappr/dm/v5")', () => {
    expect(hex(dmHkdf(key32(1), 'kc'))).toBe('3684b88af25811e446b90ba913b6555f440cc3876e9c8fe91c005d7d959aad23')
  })

  it('separates labels, fields, and label/field boundaries', () => {
    const ikm = key32(1)
    const outputs = [
      dmHkdf(ikm, 'tag', u32(0), u32(0)),
      dmHkdf(ikm, 'msg', u32(0), u32(0)),
      dmHkdf(ikm, 'tag', u32(0), u32(1)),
      dmHkdf(ikm, 'tag', u32(1), u32(0)),
      dmHkdf(ikm, 'ta', new Uint8Array([0x67])),
      dmHkdf(key32(2), 'tag', u32(0), u32(0)),
    ].map(hex)
    expect(new Set(outputs).size).toBe(outputs.length)
  })

  it('rejects labels that could collide with the NUL separator', () => {
    expect(() => kdfInfo('a\0b')).toThrow()
    expect(() => kdfInfo('')).toThrow()
  })
})

describe('integer encodings', () => {
  it('encodes big-endian u16, u32 and u64', () => {
    expect(hex(s16(0x0102))).toBe('0102')
    expect(hex(s16(0xffff))).toBe('ffff')
    expect(hex(u32(0x01020304))).toBe('01020304')
    expect(hex(u64(1754000000000))).toBe('00000198628c0400')
  })

  it('rejects out-of-range and non-integer values', () => {
    expect(() => s16(0x10000)).toThrow()
    expect(() => s16(-1)).toThrow()
    expect(() => u32(0x100000000)).toThrow()
    expect(() => u32(1.5)).toThrow()
    expect(() => u64(Number.MAX_SAFE_INTEGER + 1)).toThrow()
  })
})

describe('week numbers', () => {
  const WEEK = 604_800_000

  it('is floor(time_ms / 604,800,000)', () => {
    expect(weekOf(0)).toBe(0)
    expect(weekOf(1_758_585_600_000)).toBe(2907)
  })

  it('rolls over exactly at the week boundary', () => {
    expect(weekOf(2908 * WEEK - 1)).toBe(2907)
    expect(weekOf(2908 * WEEK)).toBe(2908)
    expect(weekStart(2908)).toBe(2908 * WEEK)
  })

  it('rejects negative times', () => {
    expect(() => weekOf(-1)).toThrow()
  })
})

describe('ByteReader', () => {
  it('reads big-endian fields and detects truncation and trailing data', () => {
    const reader = new ByteReader(concat(new Uint8Array([7]), s16(258), u32(5), u64(9), new Uint8Array([1, 2])))
    expect([reader.u8(), reader.u16(), reader.u32(), reader.u64()]).toEqual([7, 258, 5, 9])
    expect(() => reader.end()).toThrow('Trailing data')
    expect(() => reader.bytesOf(3)).toThrow('Unexpected end of data')
    expect(Array.from(reader.rest())).toEqual([1, 2])
    expect(() => reader.end()).not.toThrow()
  })
})
