import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { getPublicKey } from './crypto/keys'
import {
  REPORT_BOX_WRAP_BYTES,
  ReportBoxError,
  maxReportBoxRecipients,
  openReportBox,
  reportBoxNames,
  reportBoxSize,
  sealReportBox,
  type ReportBoxPayload,
} from './report-box'

const key = (fill: number) => new Uint8Array(32).fill(fill)
const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
const moderators = [key(1), key(2), key(3)]
const TARGET = id(40)
const payload: ReportBoxPayload = { feedOwnerId: id(50), keyGeneration: 7, cek: key(60) }

describe('the report box', () => {
  it('opens for every moderator it was sealed to, and to the same payload', () => {
    const box = sealReportBox(payload, moderators.map(getPublicKey), TARGET)
    expect(box.length).toBe(reportBoxSize(3))
    for (const moderator of moderators) {
      expect(reportBoxNames(box, getPublicKey(moderator))).toBe(true)
      expect(openReportBox(box, TARGET, moderator)).toEqual(payload)
    }
  })

  it('opens for nobody else', () => {
    const box = sealReportBox(payload, moderators.map(getPublicKey), TARGET)
    expect(reportBoxNames(box, getPublicKey(key(9)))).toBe(false)
    expect(() => openReportBox(box, TARGET, key(9))).toThrow(ReportBoxError)
  })

  it('is bound to its target: moved to another report it fails its tag', () => {
    const box = sealReportBox(payload, moderators.map(getPublicKey), TARGET)
    expect(() => openReportBox(box, id(41), moderators[0])).toThrow(/not sealed to your/)
  })

  it('refuses a box whose wraps, nonce or ciphertext were changed', () => {
    const box = sealReportBox(payload, moderators.map(getPublicKey), TARGET)
    for (const offset of [2 + 4 + 33 + 5, 2 + REPORT_BOX_WRAP_BYTES + 10, box.length - 20, box.length - 1]) {
      const tampered = box.slice()
      tampered[offset] ^= 1
      expect(() => openReportBox(tampered, TARGET, moderators[0]), `byte ${offset}`).toThrow(ReportBoxError)
    }
  })

  it('refuses an unknown version or a malformed length', () => {
    const box = sealReportBox(payload, [getPublicKey(moderators[0])], TARGET)
    const wrongVersion = box.slice()
    wrongVersion[0] = 2
    expect(() => openReportBox(wrongVersion, TARGET, moderators[0])).toThrow(/version/)
    expect(() => openReportBox(box.slice(0, -1), TARGET, moderators[0])).toThrow(/Malformed/)
  })

  it('draws a fresh key per report: two boxes of the same payload differ', () => {
    const keys = moderators.map(getPublicKey)
    expect(sealReportBox(payload, keys, TARGET)).not.toEqual(sealReportBox(payload, keys, TARGET))
  })

  it('sizes against the contract\'s 5,120 bytes: 69 bytes a moderator, room for a full team', () => {
    expect(REPORT_BOX_WRAP_BYTES).toBe(69)
    expect(reportBoxSize(1)).toBe(2 + 69 + 12 + 68 + 16)
    expect(maxReportBoxRecipients(5_120)).toBe(72)
    expect(reportBoxSize(maxReportBoxRecipients(5_120))).toBeLessThanOrEqual(5_120)
    // The leader, 15 elected members and 10 added ones.
    expect(reportBoxSize(26)).toBeLessThan(5_120)
  })

  it('refuses to seal what it could not open', () => {
    expect(() => sealReportBox(payload, [], TARGET)).toThrow(/at least one/)
    expect(() => sealReportBox({ ...payload, cek: key(1).slice(1) }, [getPublicKey(key(1))], TARGET)).toThrow(/32 bytes/)
    expect(() => sealReportBox({ ...payload, keyGeneration: 0 }, [getPublicKey(key(1))], TARGET)).toThrow(/generation/)
    expect(() => sealReportBox(payload, [new Uint8Array(65)], TARGET)).toThrow(/compressed/)
  })
})
