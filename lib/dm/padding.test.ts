import { describe, expect, it } from 'vitest'
import {
  AES_GCM_OVERHEAD,
  FIELD_MAX,
  MESSAGE_CLASSES,
  SELF_STATE_CLASSES,
  SELF_STATE_MAX_CLASS,
  joinFields,
  maxPlaintextLength,
  pad,
  sizeClassFor,
  splitFields,
  unpad,
} from './padding'
import { hex } from './test-fixtures'

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i % 251) + 1)

describe('padding (§5.7)', () => {
  it('encodes u16 length | plaintext | zeros', () => {
    const padded = pad(new Uint8Array([0xab, 0xcd]), MESSAGE_CLASSES)
    expect(padded).toHaveLength(128)
    expect(hex(padded.slice(0, 5))).toBe('0002abcd00')
    expect(padded.slice(4).every((b) => b === 0)).toBe(true)
  })

  it('switches class exactly when length + 2 passes a boundary (127/128/129-byte classes of padded size)', () => {
    expect(pad(bytes(125), MESSAGE_CLASSES)).toHaveLength(128)
    expect(pad(bytes(126), MESSAGE_CLASSES)).toHaveLength(128)
    expect(pad(bytes(127), MESSAGE_CLASSES)).toHaveLength(256)
    expect(pad(bytes(128), MESSAGE_CLASSES)).toHaveLength(256)
    expect(pad(bytes(129), MESSAGE_CLASSES)).toHaveLength(256)
    expect(pad(bytes(4094), MESSAGE_CLASSES)).toHaveLength(4096)
    expect(() => pad(bytes(4095), MESSAGE_CLASSES)).toThrow('too long')
  })

  it('round-trips every class boundary, including empty input', () => {
    for (const n of [0, 1, 126, 127, 128, 129, 254, 255, 4094]) {
      expect(unpad(pad(bytes(n), MESSAGE_CLASSES))).toEqual(bytes(n))
    }
  })

  it('rejects bad lengths and non-zero padding', () => {
    const padded = pad(bytes(10), MESSAGE_CLASSES)
    expect(() => unpad(padded.slice(0, 11))).toThrow()
    const dirty = padded.slice()
    dirty[127] = 1
    expect(() => unpad(dirty)).toThrow('Non-zero padding')
    expect(() => unpad(new Uint8Array(1))).toThrow()
  })

  it('keeps every sealed message and roster within one field, with 156 B as the smallest blob', () => {
    expect(MESSAGE_CLASSES[0] + AES_GCM_OVERHEAD).toBe(156)
    expect(MESSAGE_CLASSES[MESSAGE_CLASSES.length - 1] + AES_GCM_OVERHEAD).toBeLessThanOrEqual(FIELD_MAX)
  })

  it('sizes the largest self-state class to fill three fields exactly', () => {
    expect(SELF_STATE_MAX_CLASS + AES_GCM_OVERHEAD).toBe(3 * FIELD_MAX)
    expect(maxPlaintextLength(SELF_STATE_CLASSES)).toBe(3 * FIELD_MAX - AES_GCM_OVERHEAD - 2)
    expect(sizeClassFor(8190, SELF_STATE_CLASSES)).toBe(8192)
    expect(sizeClassFor(8191, SELF_STATE_CLASSES)).toBe(SELF_STATE_MAX_CLASS)
  })
})

describe('field splitting (§5.5)', () => {
  it('splits into full fields plus a remainder and joins back', () => {
    const blob = bytes(3 * FIELD_MAX)
    const fields = splitFields(blob)
    expect(fields.map((f) => f.length)).toEqual([FIELD_MAX, FIELD_MAX, FIELD_MAX])
    expect(joinFields(fields)).toEqual(blob)
    expect(splitFields(bytes(FIELD_MAX + 1)).map((f) => f.length)).toEqual([FIELD_MAX, 1])
    expect(splitFields(bytes(156))).toHaveLength(1)
  })

  it('rejects oversize blobs, empty input and short middle fields', () => {
    expect(() => splitFields(bytes(3 * FIELD_MAX + 1))).toThrow()
    expect(() => splitFields(new Uint8Array(0))).toThrow()
    expect(() => joinFields([])).toThrow()
    expect(() => joinFields([bytes(10), bytes(10)])).toThrow()
  })
})
