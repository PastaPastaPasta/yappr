import { expect, it } from 'vitest'
import { VARIANT, capabilities, describeRead, engine, expectCode, expectValid, sampleFeed, timed } from './harness'
import { conversationDTO, messageDTO } from '../../../src/dto/validate'
import type { ConversationRow } from '../../../src/dm/changes'

/**
 * dm.* needs a signed-in account, so the unauthenticated suite checks the
 * gate and, on testnet, the legacy read path over public data: v3
 * conversation invites name both sides in the clear (the leak DM v5 fixes),
 * so a public identity's inbox lists without a key. Nothing decrypts here:
 * no key is held, so every message reads as lib's placeholder.
 */
describeRead('dm', 'dm', () => {
  it('needs a session, and names its backend in the capabilities', async () => {
    expect((await capabilities()).dm).toBe(VARIANT === 'testnet' ? 'legacy' : 'v5')
    await expectCode(engine.dm.status(), 'NOT_SIGNED_IN')
    await expectCode(engine.dm.conversations(), 'NOT_SIGNED_IN')
    await expectCode(engine.dm.send('l:x', 'hi'), 'NOT_SIGNED_IN')
  })

  it.skipIf(VARIANT !== 'testnet')('reads a public legacy inbox with the same DTOs, and decrypts nothing without the key', async () => {
    const { createLegacyBackend } = await import('../../../src/dm/legacy')
    const { directMessageService } = await import('@/lib/services/direct-message-service')
    const backend = createLegacyBackend({ service: directMessageService, emit: () => undefined })
    const candidates = Array.from(new Set((await sampleFeed()).map(post => post.author.id))).slice(0, 8)
    let found: { identityId: string; rows: ConversationRow[] } | null = null
    for (const identityId of candidates) {
      const rows = await timed('dm.conversations (legacy, public)', () => backend.rows(identityId))
      if (rows.length > 0) {
        found = { identityId, rows }
        break
      }
    }
    if (!found) {
      console.warn(`dm: none of ${candidates.length} first-page authors has a legacy conversation; only the empty read was checked`)
      return
    }
    for (const { peerId, ...row } of found.rows) {
      expectValid(conversationDTO, { ...row, peer: null }, 'conversation')
      expect(row).toMatchObject({ backend: 'legacy', kind: 'direct', key: expect.stringMatching(/^l:/) })
      expect(peerId).not.toBe(found.identityId)
    }
    const [first] = found.rows
    const messages = await timed('dm.messages (legacy, public)', () => backend.messages(found.identityId, first.key))
    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      expectValid(messageDTO, message, 'message')
      expect([found.identityId, first.peerId]).toContain(message.sender)
      expect(message.text).toBe('[Could not decrypt message]')
    }
    await backend.deactivate()
  })
})
