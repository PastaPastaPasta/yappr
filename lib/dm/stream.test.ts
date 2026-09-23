import { describe, expect, it } from 'vitest'
import { deriveDirectKeys } from './keys'
import {
  MessageType,
  decodeContent,
  decodeGrant,
  decodePlaintext,
  decodePrev,
  decryptMessage,
  deriveStreamKey,
  encodeContent,
  encodeGrant,
  encodePrev,
  encryptMessage,
  messageAad,
  messageKey,
  messageTag,
  tryDecryptMessage,
} from './stream'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, BOB_PUB, ALICE_PUB, CAROL_ID, hex, key32, unhex } from './test-fixtures'
import type { DmPlaintext } from './types'

const { key: DIRECT_KEY } = deriveDirectKeys(ALICE_PRIV, BOB_PUB, ALICE_ID, BOB_ID)
const SK = deriveStreamKey(DIRECT_KEY, ALICE_ID)
const W = 2900

// Alice's message (w = 2900, j = 1) to Bob: prev = (2900, 0, 0, 0), text "hi bob".
const FIXED_TAG = '8334dbe0fb04d681d823d89213b91b64'
const FIXED_BODY =
  'bf62bba8ef1d98255c3b15c97617a8ad679b3e526239a7414372bc127b0b76d62e1849c38ebc4cc88c8221f13542c356cb354ccd591fcc6b6a75436e05e58993492afd626a05b8d9e23a4929ea0fa9ad1fc4df36d31ec0e841d93c3631acb348a6219997ea6552b6a805a383c5bfc0fdec305e30a1d895bc45247a4b246eb489ff1cda3ff51893d6caf6f633ff417785f95ffc4e41d579aed3d5bf37'

describe('stream keys and tags (§6.1)', () => {
  it('matches fixed vectors for SK, tag and mk', () => {
    expect(hex(SK)).toBe('f9a29ac6c7eae2da5acc51c5a8a83ead412b53cb6652358a3e00716cd8accd52')
    expect(hex(messageTag(SK, W, 0))).toBe('91087510b1d3590f1789768a5676a588')
    expect(hex(messageTag(SK, W, 1))).toBe(FIXED_TAG)
    expect(hex(messageKey(SK, W, 0))).toBe('8a5a513733af914ce1e611e1e7f07d70b37f68e4e37f0ad32abe8ac5a236b884')
  })

  it('gives each sender its own stream, and both sides the same one', () => {
    const bobSide = deriveDirectKeys(BOB_PRIV, ALICE_PUB, BOB_ID, ALICE_ID).key
    expect(deriveStreamKey(bobSide, ALICE_ID)).toEqual(SK)
    expect(hex(deriveStreamKey(DIRECT_KEY, BOB_ID))).not.toBe(hex(SK))
  })

  it('separates tag from msg, weeks from counters, and j = 0 from the week rollover', () => {
    const values = [
      messageTag(SK, W, 0),
      messageKey(SK, W, 0).slice(0, 16),
      messageTag(SK, W, 1),
      messageTag(SK, W + 1, 0),
      messageTag(SK, 0, 0),
    ].map(hex)
    expect(new Set(values).size).toBe(values.length)
  })

  it('builds the AAD as prefix || tag || senderId', () => {
    const aad = messageAad(unhex(FIXED_TAG), ALICE_ID)
    expect(new TextDecoder().decode(aad.slice(0, 15))).toBe('yappr/dm/msg/v5')
    expect(aad).toHaveLength(15 + 16 + 32)
  })
})

describe('prev (§6.1)', () => {
  it('encodes U32 w | S16 b | S16 r | U32 j', () => {
    expect(hex(encodePrev({ w: 2900, b: 1, r: 2, j: 3 }))).toBe('00000b540001000200000003')
  })

  it('encodes "none" as zeros and decodes zeros as none', () => {
    expect(hex(encodePrev(null))).toBe('000000000000000000000000')
    expect(decodePrev(new Uint8Array(12))).toBeNull()
  })

  it('round-trips j = 0 and the maximum values', () => {
    for (const p of [{ w: W, b: 0, r: 0, j: 0 }, { w: 0xffffffff, b: 0xffff, r: 0xffff, j: 0xffffffff }]) {
      expect(decodePrev(encodePrev(p))).toEqual(p)
    }
  })

  it('rejects a wrong length', () => {
    expect(() => decodePrev(new Uint8Array(11))).toThrow()
  })
})

describe('message types (§6.2)', () => {
  const grant = { gid: unhex('36bcf5d162c4be1412d2'), b: 1, r: 2, key: key32(9) }

  it('encodes a grant as gid | S16 b | S16 r | K', () => {
    expect(hex(encodeGrant(grant))).toBe('36bcf5d162c4be1412d200010002' + '09'.repeat(32))
    expect(decodeGrant(encodeGrant(grant))).toEqual(grant)
    expect(() => decodeGrant(encodeGrant(grant).slice(1))).toThrow()
    expect(() => encodeGrant({ ...grant, gid: new Uint8Array(9) })).toThrow()
  })

  it('round-trips text, leave, grant and unknown types', () => {
    const contents = [
      { type: 'text' as const, text: 'héllo 👋' },
      { type: 'text' as const, text: '\ufeffkeeps a leading BOM' },
      { type: 'leave' as const },
      { type: 'grant' as const, grant },
      { type: 'unknown' as const, code: 0x10, payload: new Uint8Array([1, 2]) },
    ]
    for (const content of contents) expect(decodeContent(encodeContent(content))).toEqual(content)
    expect(encodeContent({ type: 'text', text: 'a' })[0]).toBe(MessageType.TEXT)
    expect(encodeContent({ type: 'leave' })[0]).toBe(MessageType.LEAVE)
    expect(encodeContent({ type: 'grant', grant })[0]).toBe(MessageType.GRANT)
  })

  it('rejects invalid UTF-8 text, a leave with a payload, and an empty body', () => {
    expect(() => decodeContent(new Uint8Array([MessageType.TEXT, 0xff]))).toThrow()
    expect(() => decodeContent(new Uint8Array([MessageType.LEAVE, 0]))).toThrow()
    expect(() => decodeContent(new Uint8Array(0))).toThrow()
    expect(() => decodePlaintext(new Uint8Array(12))).toThrow()
    expect(() => encodeContent({ type: 'unknown', code: 0x100, payload: new Uint8Array(0) })).toThrow()
  })
})

describe('message encryption (§6.1)', () => {
  const position = { streamKey: SK, senderId: ALICE_ID, w: W, j: 1 }
  const message: DmPlaintext = { prev: { w: W, b: 0, r: 0, j: 0 }, content: { type: 'text', text: 'hi bob' } }

  it('decrypts a fixed body', async () => {
    expect(await decryptMessage(position, unhex(FIXED_BODY))).toEqual(message)
  })

  it('round-trips, padded to the 128-byte class', async () => {
    const { tag, body } = await encryptMessage(position, message)
    expect(hex(tag)).toBe(FIXED_TAG)
    expect(body).toHaveLength(156)
    expect(await decryptMessage(position, body)).toEqual(message)
  })

  it('round-trips an empty prev (first message, j = 0)', async () => {
    const first = { ...position, j: 0 }
    const msg: DmPlaintext = { prev: null, content: { type: 'text', text: '' } }
    const { body } = await encryptMessage(first, msg)
    expect(await decryptMessage(first, body)).toEqual(msg)
  })

  it('fails at the wrong position, under the wrong sender, or with the wrong key', async () => {
    const body = unhex(FIXED_BODY)
    await expect(decryptMessage({ ...position, j: 2 }, body)).rejects.toThrow()
    await expect(decryptMessage({ ...position, w: W + 1 }, body)).rejects.toThrow()
    await expect(decryptMessage({ ...position, senderId: CAROL_ID }, body)).rejects.toThrow()
    await expect(decryptMessage({ ...position, streamKey: deriveStreamKey(DIRECT_KEY, BOB_ID) }, body)).rejects.toThrow()
  })

  it('fails on a tampered body', async () => {
    const body = unhex(FIXED_BODY)
    body[40] ^= 1
    await expect(decryptMessage(position, body)).rejects.toThrow()
  })

  it('returns null from tryDecryptMessage on any failure, including authenticated but malformed content', async () => {
    expect(await tryDecryptMessage(position, unhex(FIXED_BODY))).toEqual(message)
    expect(await tryDecryptMessage({ ...position, j: 2 }, unhex(FIXED_BODY))).toBeNull()
    expect(await tryDecryptMessage(position, new Uint8Array(12))).toBeNull()
    const leaveWithPayload = { prev: null, content: { type: 'unknown' as const, code: MessageType.LEAVE, payload: new Uint8Array([1]) } }
    const { body } = await encryptMessage(position, leaveWithPayload)
    await expect(decryptMessage(position, body)).rejects.toThrow('Leave carries no payload')
    expect(await tryDecryptMessage(position, body)).toBeNull()
  })

  it('rejects sender ids that are not 32 bytes', () => {
    expect(() => deriveStreamKey(DIRECT_KEY, ALICE_ID.slice(1))).toThrow('32 bytes')
    expect(() => messageAad(unhex(FIXED_TAG), new Uint8Array(33))).toThrow('32 bytes')
  })

  it('rejects text too long for one field', async () => {
    const huge: DmPlaintext = { prev: null, content: { type: 'text', text: 'x'.repeat(4096) } }
    await expect(encryptMessage(position, huge)).rejects.toThrow('too long')
  })
})
