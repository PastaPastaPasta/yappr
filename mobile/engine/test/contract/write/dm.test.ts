/**
 * dm.* on sakura's DM v5 contract with pool personas (ENGINE.md §12.3): a
 * 1:1 round trip between two slots, then a group created, renamed, grown and
 * left. lib has one session slot, so each side takes its turn through the
 * account switch (an engine restart, as on the phone), which also exercises
 * the DM stop-and-flush on switch. Encryption keys are keyId 4, entered
 * through `dm.unlock`. Serial; only identity ids are logged, never text.
 *
 * DM v5 has no cheap delete: the messages and the group stay on chain (the
 * retention sweep would reclaim them; it is off for test runs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import { loadPoolPersonas, type PoolPersona } from '../../../harness/pool'
import type { ConversationDTO, DmEvents, WriteTicket } from '../../../src/api'
import { connectEngine } from '../engine'
import { devnetEnv, writeSuiteSkipReason } from './env'

function skipReason(): string | null {
  const reason = writeSuiteSkipReason()
  if (reason) return reason
  const env = devnetEnv()
  return env.NEXT_PUBLIC_DM_TOPOLOGY === 'v5' && env.NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID ? null : '.env.devnet does not configure DM v5'
}

const skip = skipReason()
const RUN = Date.now().toString(36)
const POLL_MS = 5_000
const WAIT_MS = 180_000
const HELLO = `hello from the mobile engine ${RUN}`
const connect = () => connectEngine({ timeoutMs: 300_000 })

describe.skipIf(skip !== null)(`dm on sakura${skip ? ` (skipped: ${skip})` : ''}`, () => {
  let alice: PoolPersona
  let bob: PoolPersona
  let carol: PoolPersona
  let engine: ReturnType<typeof connect>
  const signedIn = new Set<string>()
  let addedDocument = false

  /** Make `persona` the active account (sign in on first use, else switch), restarting the engine, and unlock DMs. */
  async function become(persona: PoolPersona): Promise<void> {
    const active = await engine.api.session.current()
    if (active?.identityId === persona.identityId) return
    if (signedIn.has(persona.identityId)) {
      await engine.api.session.switchAccount(persona.identityId)
      engine = connect()
      expect((await engine.api.session.restore())?.identityId).toBe(persona.identityId)
    } else {
      if (active) {
        await engine.api.session.prepareAddAccount()
        engine = connect()
        await engine.api.session.restore()
      }
      await engine.api.session.signInWithKey({ key: persona.keyHex('high') })
      signedIn.add(persona.identityId)
    }
    if ((await engine.api.dm.status()).locked) expect(await engine.api.dm.unlock({ key: persona.keyHex('encryption') })).toMatchObject({ unlocked: true })
    // As the app does: conversations are named only once the saved state has loaded (ENGINE_BUSY before).
    for (let waited = 0; !(await engine.api.dm.status()).ready; waited += 500) {
      if (waited >= WAIT_MS) throw new Error(`messages did not load within ${WAIT_MS / 1000} s`)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  async function settled(ticket: WriteTicket): Promise<WriteTicket> {
    for (let waited = 0; waited < WAIT_MS; waited += 500) {
      const current = await engine.api.writes.get(ticket.id)
      if (current && current.state !== 'pending') {
        // The classified error (code and copy, never message text) tells a refusal from a transient.
        if (current.error) console.warn(`${ticket.op} ${current.state}: ${current.error.code} ${current.error.userMessage}`)
        return current
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`ticket ${ticket.id} (${ticket.op}) still pending after ${WAIT_MS / 1000} s`)
  }

  /** Poll (as the foreground app does) until a conversation matches. */
  async function conversation(match: (conversation: ConversationDTO) => boolean): Promise<ConversationDTO> {
    for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
      await engine.api.engine.lifecycle('active')
      const found = (await engine.api.dm.conversations()).find(match)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
    throw new Error(`no matching conversation after ${WAIT_MS / 1000} s`)
  }

  const messageEvents = () => engine.events.filter(e => e.event === 'dm.message').map(e => e.payload as DmEvents['dm.message'])

  beforeAll(async () => {
    const personas = loadPoolPersonas()
    ;[alice, bob, carol] = [personas[4], personas[5], personas[6]]
    // lib's DM v5 flush listens on `document` (the WebView's); Node has none.
    if (typeof document === 'undefined') {
      Object.assign(globalThis, { document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) })
      addedDocument = true
    }
    engine = connect()
    await engine.api.engine.boot()
    await engine.api.session.signOut()
    expect((await engine.api.engine.info()).capabilities.dm).toBe('v5')
  })

  afterAll(async () => {
    for (const identityId of signedIn) await engine.api.session.signOut({ identityId }).catch(() => undefined)
    if (addedDocument) Reflect.deleteProperty(globalThis, 'document')
  })

  it('1:1 round trip between two pool slots', async () => {
    await become(alice)
    const key = await engine.api.dm.startDirect(bob.identityId)
    const sent = await settled(await engine.api.dm.send(key, HELLO))
    expect(sent).toMatchObject({ op: 'dm.send', state: 'confirmed' })

    await become(bob)
    const inbox = await conversation(c => c.peer?.id === alice.identityId && c.lastMessage?.text === HELLO)
    expect(inbox).toMatchObject({ backend: 'v5', kind: 'direct', lastMessage: { own: false } })
    expect(inbox.unread).toBeGreaterThan(0)
    // dm.message is coalesced with dm.changed (250 ms).
    await vi.waitFor(() => expect(messageEvents().some(e => e.key === inbox.key && e.message.text.endsWith(RUN))).toBe(true), { timeout: 5_000 })
    await engine.api.dm.markRead(inbox.key)
    expect((await engine.api.dm.conversations()).find(c => c.key === inbox.key)?.unread).toBe(0)
    expect(await settled(await engine.api.dm.send(inbox.key, `reply ${RUN}`))).toMatchObject({ state: 'confirmed' })

    await become(alice)
    await conversation(c => c.key === key && c.lastMessage?.text === `reply ${RUN}`)
    const page = await engine.api.dm.messages(key)
    expect(page.items.slice(0, 2).map(m => [m.text, m.own])).toEqual([[`reply ${RUN}`, false], [HELLO, true]])
  })

  it('group: create, rename (its answer lost after the broadcast), add a member, a member leaves', async () => {
    await become(alice)
    const creating = await settled(await engine.api.dm.createGroup(`Mobile engine ${RUN}`, [bob.identityId]))
    expect(creating).toMatchObject({ op: 'dm.group', state: 'confirmed' })
    const created = await engine.api.dm.createdGroup(creating.id)
    expect(created?.failed).toEqual([])
    const key = created?.key ?? ''
    // The rename's replace lands, but its answer is lost, as a WebView's "Failed to fetch" after the
    // broadcast: lib keeps that SDK-signed transition pending. The DM engine sees the rename land, so
    // the next group change must go through, not fail PENDING_WRITE for 15 minutes.
    const sdk = await getEvoSdk()
    const replace = sdk.documents.replace.bind(sdk.documents)
    let lost = false
    sdk.documents.replace = (async (...args: Parameters<typeof replace>) => {
      const result = await replace(...args)
      if (lost) return result
      lost = true
      throw new Error('transport error: grpc error: code: \'Internal error\', message: "Failed to call gRPC service: JS API error: TypeError: Failed to fetch"')
    }) as typeof replace
    try {
      expect(await settled(await engine.api.dm.renameGroup(key, `Renamed ${RUN}`))).toMatchObject({ state: 'confirmed' })
      expect(lost).toBe(true)
      expect(await settled(await engine.api.dm.addMember(key, carol.identityId))).toMatchObject({ state: 'confirmed' })
    } finally {
      sdk.documents.replace = replace
    }
    const owned = (await engine.api.dm.conversations()).find(c => c.key === key)
    expect(owned).toMatchObject({ kind: 'group', isOwner: true, name: `Renamed ${RUN}` })
    expect([...(owned?.members ?? [])].sort()).toEqual([alice.identityId, bob.identityId, carol.identityId].sort())

    await become(bob)
    const group = await conversation(c => c.key === key && c.name === `Renamed ${RUN}`)
    expect(group).toMatchObject({ ownerId: alice.identityId, isOwner: false })
    expect(await settled(await engine.api.dm.leaveGroup(key))).toMatchObject({ state: 'confirmed' })
    expect((await engine.api.dm.conversations()).find(c => c.key === key)?.flags.hidden).toBe(true)
  })
})
