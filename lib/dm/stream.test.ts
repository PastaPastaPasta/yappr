import { describe, expect, it } from 'vitest'
import { deriveDirectKeys, deriveEpochKey, deriveGroupId, deriveGroupSecret, deriveSelfRoot } from './keys'
import {
  directOwnerId,
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
  isStrictlyBefore,
  messageAad,
  messageKey,
  messageTag,
  tryDecryptMessage,
} from './stream'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, BOB_PUB, ALICE_PUB, CAROL_ID, hex, key32, unhex } from './test-fixtures'
import type { DmPlaintext } from './types'

const { key: DIRECT_KEY } = deriveDirectKeys(ALICE_PRIV, BOB_PUB, ALICE_ID, BOB_ID)
const SK = deriveStreamKey(DIRECT_KEY, directOwnerId(), ALICE_ID)
const W = 2900

// Alice's message (w = 2900, j = 1) to Bob: prev = (2900, 0, 0, 0), text "hi bob".
const FIXED_TAG = '624ed8a736d417f7b905d9cf5c7ee4a5'
const FIXED_BODY =
  '0e25024241c08316254818165cddb9b184824cf8f0e173b72d4b49e80971e24849d2b977fb60ea0acbc5ec65ec3855736ce0e838a66f03cd2cf34184534ef6285d96feb1577160be4d47606b65021af585e502257e5aef078c4cc02a469cb7f0179fb377da3562b0166968e148c5ddf542c51560c04c8569fde198a4f07b5da16a2ed8e4dee560babc1b69491259a287f2f492b429a743a16b7cba5b'

describe('stream keys and tags (§6.1)', () => {
  it('matches fixed vectors for a 1:1 SK (zero owner), tag and mk', () => {
    expect(hex(directOwnerId())).toBe('00'.repeat(32))
    expect(hex(SK)).toBe('a83a40eb15f9f4df92c1b74d4d4d4d359ca009856f09777b0eaaddbb15b951be')
    expect(hex(messageTag(SK, W, 0))).toBe('0f796b75dc98f2f2efad53c8b7e11293')
    expect(hex(messageTag(SK, W, 1))).toBe(FIXED_TAG)
    expect(hex(messageKey(SK, W, 0))).toBe('3e532fdec9cb46eb322d84b7dd90ba46dc19e6684371279ae58985dd60bfd485')
  })

  it('matches a fixed vector for a group SK bound to the owner', () => {
    const gid = deriveGroupId(deriveSelfRoot(ALICE_PRIV), 0)
    const k01 = deriveEpochKey(deriveGroupSecret(ALICE_PRIV, gid), 0, 1)
    const groupSk = deriveStreamKey(k01, ALICE_ID, BOB_ID)
    expect(hex(groupSk)).toBe('ff16a86f540a299930aa63d52b314e1eec306a15947422e08a3c002915676fb0')
    expect(hex(messageTag(groupSk, W, 0))).toBe('c670d3fd913c6bb098cb4142469b5004')
  })

  it('gives a forked group (same K, different owner) entirely different tags', () => {
    const real = deriveStreamKey(DIRECT_KEY, ALICE_ID, BOB_ID)
    const forked = deriveStreamKey(DIRECT_KEY, CAROL_ID, BOB_ID)
    for (const j of [0, 1, 2]) expect(hex(messageTag(forked, W, j))).not.toBe(hex(messageTag(real, W, j)))
    expect(hex(deriveStreamKey(DIRECT_KEY, directOwnerId(), BOB_ID))).not.toBe(hex(real))
  })

  it('gives each sender its own stream, and both sides the same one', () => {
    const bobSide = deriveDirectKeys(BOB_PRIV, ALICE_PUB, BOB_ID, ALICE_ID).key
    expect(deriveStreamKey(bobSide, directOwnerId(), ALICE_ID)).toEqual(SK)
    expect(hex(deriveStreamKey(DIRECT_KEY, directOwnerId(), BOB_ID))).not.toBe(hex(SK))
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

  it('orders pointers by (b, r, w, j) with isStrictlyBefore', () => {
    const cur = { w: W, b: 1, r: 2, j: 5 }
    // Same epoch: earlier week, or same week and earlier j.
    expect(isStrictlyBefore({ ...cur, j: 4 }, cur)).toBe(true)
    expect(isStrictlyBefore({ ...cur, w: W - 1, j: 99 }, cur)).toBe(true)
    expect(isStrictlyBefore({ ...cur, j: 0 }, cur)).toBe(true)
    // Earlier epoch wins even with a later week (a straggler on the old base).
    expect(isStrictlyBefore({ ...cur, r: 1, w: W + 1 }, cur)).toBe(true)
    expect(isStrictlyBefore({ ...cur, b: 0, r: 9, w: W + 1 }, cur)).toBe(true)
    // Equal, forward and later-epoch pointers are rejected.
    expect(isStrictlyBefore(cur, cur)).toBe(false)
    expect(isStrictlyBefore({ ...cur, j: 6 }, cur)).toBe(false)
    expect(isStrictlyBefore({ ...cur, w: W + 1, j: 0 }, cur)).toBe(false)
    expect(isStrictlyBefore({ ...cur, r: 3, w: W - 5 }, cur)).toBe(false)
    expect(isStrictlyBefore({ ...cur, b: 2, r: 0, w: W - 5 }, cur)).toBe(false)
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
    await expect(decryptMessage({ ...position, streamKey: deriveStreamKey(DIRECT_KEY, directOwnerId(), BOB_ID) }, body)).rejects.toThrow()
    await expect(decryptMessage({ ...position, streamKey: deriveStreamKey(DIRECT_KEY, CAROL_ID, ALICE_ID) }, body)).rejects.toThrow()
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
    expect(() => deriveStreamKey(DIRECT_KEY, directOwnerId(), ALICE_ID.slice(1))).toThrow('32 bytes')
    expect(() => deriveStreamKey(DIRECT_KEY, new Uint8Array(0), ALICE_ID)).toThrow('32 bytes')
    expect(() => messageAad(unhex(FIXED_TAG), new Uint8Array(33))).toThrow('32 bytes')
  })

  it('rejects text too long for one field', async () => {
    const huge: DmPlaintext = { prev: null, content: { type: 'text', text: 'x'.repeat(4096) } }
    await expect(encryptMessage(position, huge)).rejects.toThrow('too long')
  })
})
