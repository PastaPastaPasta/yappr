import { describe, expect, it } from 'vitest'
import { bytesEqual } from '@/lib/bytes'
import { deriveBaseKey, deriveGroupId, deriveGroupSecret } from '@/lib/dm/keys'
import { encryptRoster, rosterHandle } from '@/lib/dm/group'
import { encryptMessage } from '@/lib/dm/stream'
import { weekOf } from '@/lib/dm/kdf'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV, CAROL_ID, CAROL_PRIV } from '@/lib/dm/test-fixtures'
import type { IdentityId } from '@/lib/dm/types'
import { currentEpoch, members, stream, timeline, type GroupConv } from './conversation'
import { attachGroup, attachSaved, groupConv, type DmContext } from './context'
import { startedDirect } from './directs'
import { addMember, createGroup, endGroup, leaveGroup, recoverOwnedGroups, removeMember, renameGroup, resendKeys } from './groups'
import { pollOnce } from './loop'
import { backfill } from './poller'
import { SendError, sendContent } from './sender'
import { MemoryLedger, makeContext } from './test-chain'
import { STALE_WINDOW_MS } from './util'

const DAVE_ID = Uint8Array.from({ length: 32 }, () => 0xdd)
const DAVE_PRIV = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)

function world() {
  const ledger = new MemoryLedger()
  return {
    ledger,
    alice: makeContext(ledger, ALICE_ID, ALICE_PRIV),
    bob: makeContext(ledger, BOB_ID, BOB_PRIV),
    carol: makeContext(ledger, CAROL_ID, CAROL_PRIV),
    dave: makeContext(ledger, DAVE_ID, DAVE_PRIV),
  }
}

function theGroup(ctx: DmContext, owner: IdentityId, gid: Uint8Array): GroupConv {
  const conv = groupConv(ctx, owner, gid)
  if (!conv) throw new Error('group not found')
  return conv
}

const groupTexts = (conv: GroupConv) => timeline(conv).flatMap((m) => (m.content.type === 'text' ? [m.content.text] : []))
const has = (list: IdentityId[], id: IdentityId) => list.some((m) => bytesEqual(m, id))

async function say(ctx: DmContext, conv: GroupConv, text: string) {
  await sendContent(ctx, conv, { type: 'text', text })
}

describe('group create and grants', () => {
  it('creates a roster, grants each member on the 1:1 stream, and members accept and read', async () => {
    const { ledger, alice, bob, carol } = world()
    const { conv, failed } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    expect(failed).toEqual([])
    expect(ledger.groupDocs).toHaveLength(1) // one roster
    expect(ledger.invites).toHaveLength(2) // one per member never messaged before

    await say(alice.ctx, conv, 'welcome')
    await pollOnce(bob.ctx)
    await pollOnce(carol.ctx)
    const bobGroup = theGroup(bob.ctx, ALICE_ID, conv.gid)
    expect(bobGroup.lastRoster?.name).toBe('Team')
    await pollOnce(bob.ctx)
    expect(groupTexts(bobGroup)).toEqual(['welcome'])

    await say(bob.ctx, bobGroup, 'hi all')
    await pollOnce(alice.ctx)
    await pollOnce(carol.ctx)
    await pollOnce(carol.ctx)
    expect(groupTexts(theGroup(carol.ctx, ALICE_ID, conv.gid)).sort()).toEqual(['hi all', 'welcome'])
    expect(groupTexts(conv).sort()).toEqual(['hi all', 'welcome'])
  })

  it('rejects a grant forwarded by a non-owner (the roster lives under the real owner)', async () => {
    const { alice, bob, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    await pollOnce(bob.ctx)
    // Bob forwards the key to Carol on his own 1:1 stream: Carol looks for the roster under Bob and finds none.
    const bobToCarol = await startedDirect(bob.ctx, CAROL_ID)
    await sendContent(bob.ctx, bobToCarol, { type: 'grant', grant: { gid: conv.gid, b: 0, r: 0, key: conv.keys.get({ b: 0, r: 0 }) ?? new Uint8Array(32) } })
    await pollOnce(carol.ctx)
    expect(groupConv(carol.ctx, BOB_ID, conv.gid)).toBeNull()
    expect(groupConv(carol.ctx, ALICE_ID, conv.gid)).toBeNull()
  })

  it('keeps a grant whose roster has not been replaced yet and accepts it once it has', async () => {
    const { alice, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    // Alice grants Carol at (0, 1) but her roster replace has not landed yet.
    const direct = await startedDirect(alice.ctx, CAROL_ID)
    const next = conv.keys.get({ b: 0, r: 1 })
    if (!next) throw new Error('no key')
    await sendContent(alice.ctx, direct, { type: 'grant', grant: { gid: conv.gid, b: 0, r: 1, key: next } })
    await pollOnce(carol.ctx)
    expect(carol.ctx.pendingGrants.size).toBe(1)
    expect(groupConv(carol.ctx, ALICE_ID, conv.gid)).toBeNull()

    // The roster replace lands: Carol accepts on her next poll.
    const replaced = await alice.chain.replaceGroupDoc(conv.roster ?? { id: '', revision: 0 }, rosterHandle(conv.gid),
      await encryptRoster(next, conv.gid, { b: 0, r: 1, name: 'Team', avatarRef: '', members: [ALICE_ID, BOB_ID, CAROL_ID], ended: false }))
    expect(replaced.ok).toBe(true)
    await pollOnce(carol.ctx)
    expect(groupConv(carol.ctx, ALICE_ID, conv.gid)).not.toBeNull()
    expect(carol.ctx.pendingGrants.size).toBe(0)
  })

  it('drops a pending grant after the stale window', async () => {
    const { ledger, alice, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    const direct = await startedDirect(alice.ctx, CAROL_ID)
    const key = conv.keys.get({ b: 0, r: 5 })
    if (!key) throw new Error('no key')
    await sendContent(alice.ctx, direct, { type: 'grant', grant: { gid: conv.gid, b: 0, r: 5, key } })
    await pollOnce(carol.ctx)
    expect(carol.ctx.pendingGrants.size).toBe(1)
    ledger.time += STALE_WINDOW_MS + 1
    await pollOnce(carol.ctx)
    expect(carol.ctx.pendingGrants.size).toBe(0)
  })
})

describe('membership changes', () => {
  it('adds a member by ratchet: existing members step forward, the newcomer cannot read the past', async () => {
    const { alice, bob, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    await say(alice.ctx, conv, 'before carol')
    await pollOnce(bob.ctx)

    await addMember(alice.ctx, conv, CAROL_ID)
    expect(currentEpoch(conv)).toEqual({ b: 0, r: 1 })
    await say(alice.ctx, conv, 'after carol')

    await pollOnce(bob.ctx)
    await pollOnce(bob.ctx)
    const bobGroup = theGroup(bob.ctx, ALICE_ID, conv.gid)
    expect(currentEpoch(bobGroup)).toEqual({ b: 0, r: 1 })
    expect(groupTexts(bobGroup)).toEqual(['before carol', 'after carol'])

    await pollOnce(carol.ctx)
    await pollOnce(carol.ctx)
    const carolGroup = theGroup(carol.ctx, ALICE_ID, conv.gid)
    expect(groupTexts(carolGroup)).toEqual(['after carol'])
    expect(carolGroup.keys.get({ b: 0, r: 0 })).toBeNull()
  })

  it('removes a member with a keyring: others switch base, the removed member stops', async () => {
    const { ledger, alice, bob, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(bob.ctx)
    await pollOnce(carol.ctx)

    await removeMember(alice.ctx, conv, CAROL_ID)
    expect(currentEpoch(conv)).toEqual({ b: 1, r: 0 })
    expect(ledger.groupDocs).toHaveLength(2) // roster + keyring 1
    await say(alice.ctx, conv, 'carol is gone')

    await pollOnce(bob.ctx)
    await pollOnce(bob.ctx)
    const bobGroup = theGroup(bob.ctx, ALICE_ID, conv.gid)
    expect(currentEpoch(bobGroup)).toEqual({ b: 1, r: 0 })
    expect(has(members(bobGroup, BOB_ID), CAROL_ID)).toBe(false)
    expect(groupTexts(bobGroup)).toEqual(['carol is gone'])

    await pollOnce(carol.ctx)
    const carolGroup = theGroup(carol.ctx, ALICE_ID, conv.gid)
    expect(carolGroup.removed).toBe(true)
    expect(groupTexts(carolGroup)).toEqual([])
  })

  it('drops a removed member old-base message dated after the keyring, but keeps a member one', async () => {
    const { ledger, alice, bob, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(bob.ctx)
    await pollOnce(carol.ctx)
    const carolGroup = theGroup(carol.ctx, ALICE_ID, conv.gid)
    await say(carol.ctx, carolGroup, 'before removal')
    await pollOnce(bob.ctx)

    const base0 = stream(conv, ALICE_ID, { b: 0, r: 0 })
    await removeMember(alice.ctx, conv, CAROL_ID)
    ledger.tick()
    // Neither Carol nor one of Alice's devices has seen the keyring yet; both write on base 0 after it.
    carolGroup.appliedAt = ledger.time
    await say(carol.ctx, carolGroup, 'after removal')
    if (!base0) throw new Error('no stream')
    const { tag, body } = await encryptMessage({ streamKey: base0.key, senderId: ALICE_ID, w: weekOf(ledger.time), j: 0 }, { prev: null, content: { type: 'text', text: 'owner, old base' } })
    await alice.chain.createMessage(tag, body)

    await pollOnce(bob.ctx)
    await pollOnce(bob.ctx)
    const bobGroup = theGroup(bob.ctx, ALICE_ID, conv.gid)
    expect(groupTexts(bobGroup).sort()).toEqual(['before removal', 'owner, old base'])
  })

  it('repairs a roster that trails the newest keyring before any other change (§6.5)', async () => {
    const { alice, bob, carol, dave } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(carol.ctx)
    // The roster replace after the removal fails, leaving the roster on base 0.
    alice.chain.hook = (method) => (method === 'replaceGroupDoc' ? { ok: false, failure: 'other', error: 'network' } : null)
    await expect(removeMember(alice.ctx, conv, CAROL_ID)).rejects.toThrow('network')
    alice.chain.hook = null

    // Next owner write: rebuild members from the keyring slots (Carol has none), then add Dave.
    await addMember(alice.ctx, conv, DAVE_ID)
    expect(currentEpoch(conv)).toEqual({ b: 1, r: 1 })
    const roster = conv.lastRoster
    expect(roster && has(roster.members, CAROL_ID)).toBe(false)
    expect(roster && has(roster.members, BOB_ID) && has(roster.members, DAVE_ID)).toBe(true)

    await pollOnce(bob.ctx)
    await pollOnce(bob.ctx)
    expect(currentEpoch(theGroup(bob.ctx, ALICE_ID, conv.gid))).toEqual({ b: 1, r: 1 })
    await pollOnce(dave.ctx)
    await pollOnce(dave.ctx)
    expect(theGroup(dave.ctx, ALICE_ID, conv.gid).lastRoster?.name).toBe('Team')
    await pollOnce(carol.ctx)
    expect(theGroup(carol.ctx, ALICE_ID, conv.gid).removed).toBe(true)
  })

  it('never lets someone removed before they first polled join', async () => {
    const { alice, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await removeMember(alice.ctx, conv, CAROL_ID)
    await pollOnce(carol.ctx)
    await pollOnce(carol.ctx)
    expect(groupConv(carol.ctx, ALICE_ID, conv.gid)).toBeNull()
  })

  it('builds every owner change on the current roster, even after another owner device changed it', async () => {
    const { ledger, alice } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    const tablet = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await renameGroup(tablet.ctx, attachGroup(tablet.ctx, { ...conv.entry }), 'Renamed')
    await addMember(alice.ctx, conv, CAROL_ID)
    expect(conv.lastRoster?.name).toBe('Renamed')
    expect(conv.lastRoster && has(conv.lastRoster.members, CAROL_ID)).toBe(true)
  })

  it('re-runs the owner loop when the roster replace is refused as stale (40106)', async () => {
    const { alice } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    let refusals = 0
    alice.chain.hook = (method) => {
      if (method !== 'replaceGroupDoc' || refusals > 0) return null
      refusals++
      return { ok: false, failure: 'stale', error: 'has invalid revision code=40106' }
    }
    await renameGroup(alice.ctx, conv, 'Again')
    expect(refusals).toBe(1)
    expect(conv.lastRoster?.name).toBe('Again')
  })

  it('leave: the member sends 0x02 and the owner removes them on its next poll', async () => {
    const { alice, bob, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(carol.ctx)
    await pollOnce(carol.ctx)
    await leaveGroup(carol.ctx, theGroup(carol.ctx, ALICE_ID, conv.gid))
    await pollOnce(alice.ctx)
    expect(alice.ctx.pendingLeaves.size).toBe(0)
    expect(currentEpoch(conv)).toEqual({ b: 1, r: 0 })
    expect(conv.lastRoster && has(conv.lastRoster.members, CAROL_ID)).toBe(false)
    expect(conv.lastRoster && has(conv.lastRoster.members, BOB_ID)).toBe(true)
    await pollOnce(bob.ctx)
    await pollOnce(bob.ctx)
    expect(currentEpoch(theGroup(bob.ctx, ALICE_ID, conv.gid))).toEqual({ b: 1, r: 0 })
  })

  it('rename and end: members see the new name, then the tombstone', async () => {
    const { alice, bob } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    await pollOnce(bob.ctx)
    await renameGroup(alice.ctx, conv, 'New name')
    await pollOnce(bob.ctx)
    const bobGroup = theGroup(bob.ctx, ALICE_ID, conv.gid)
    expect(bobGroup.lastRoster?.name).toBe('New name')
    await endGroup(alice.ctx, conv)
    await pollOnce(bob.ctx)
    expect(bobGroup.ended).toBe(true)
    await expect(say(bob.ctx, bobGroup, 'x')).rejects.toThrow(/no longer a member/)
  })

  it('resend keys: a member who lost the key recovers it from a fresh grant', async () => {
    const { ledger, alice } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    await addMember(alice.ctx, conv, CAROL_ID)
    // Bob's grant was never seen (retention swept it); his device knows nothing.
    const fresh = makeContext(ledger, BOB_ID, BOB_PRIV)
    fresh.ctx.appJustOpened = true
    await resendKeys(alice.ctx, conv, BOB_ID)
    await pollOnce(fresh.ctx)
    await pollOnce(fresh.ctx)
    const group = theGroup(fresh.ctx, ALICE_ID, conv.gid)
    expect(currentEpoch(group)).toEqual({ b: 0, r: 1 })
  })
})

describe('owner group recovery', () => {
  it('finds owned groups by probing gid_n until an empty batch, and never reuses n', async () => {
    const { ledger, alice } = world()
    await createGroup(alice.ctx, 'One', [BOB_ID])
    await createGroup(alice.ctx, 'Two', [BOB_ID])
    const fresh = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    fresh.ctx.store.state.nextGroupNumber = 0
    expect(await recoverOwnedGroups(fresh.ctx)).toBe(2)
    expect(fresh.ctx.store.state.nextGroupNumber).toBe(2)
    const gid0 = deriveGroupId(fresh.ctx.me.selfRoot, 0)
    const g0 = groupConv(fresh.ctx, ALICE_ID, gid0)
    expect(g0?.entry.earliestKey).toEqual(deriveBaseKey(deriveGroupSecret(ALICE_PRIV, gid0), 0))

    // A new group from a device that forgot n: the taken handles are skipped.
    const other = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    const { conv } = await createGroup(other.ctx, 'Three', [BOB_ID])
    expect(conv.gid).toEqual(deriveGroupId(other.ctx.me.selfRoot, 2))
  })

  it('probes streams with the owner group key after recovery', async () => {
    const { ledger, alice } = world()
    const { conv } = await createGroup(alice.ctx, 'One', [BOB_ID])
    await say(alice.ctx, conv, 'hello')
    const fresh = makeContext(ledger, ALICE_ID, ALICE_PRIV)
    await recoverOwnedGroups(fresh.ctx)
    await pollOnce(fresh.ctx)
    await pollOnce(fresh.ctx)
    const g = theGroup(fresh.ctx, ALICE_ID, conv.gid)
    expect(groupTexts(g)).toEqual(['hello'])
    expect(stream(g, ALICE_ID, { b: 0, r: 0 })?.cur?.j).toBe(0)
  })
})

describe('nonce clashes on owner writes', () => {
  it('creates a group through nonce clashes on the roster and on a member\'s invite', async () => {
    const { ledger, alice, bob, carol } = world()
    let rosterClashes = 0
    let inviteClashes = 0
    alice.chain.hook = (method) => {
      const clash = { ok: false as const, failure: 'nonce' as const, error: 'nonce already present at tip' }
      if (method === 'createGroupDoc' && rosterClashes < 1) return (rosterClashes++, clash)
      if (method === 'createInvite' && inviteClashes < 1) return (inviteClashes++, clash)
      return null
    }
    const { conv, failed } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    expect(failed).toEqual([])
    expect(ledger.groupDocs).toHaveLength(1)
    expect(ledger.invites).toHaveLength(2)
    await pollOnce(bob.ctx)
    await pollOnce(carol.ctx)
    expect(theGroup(bob.ctx, ALICE_ID, conv.gid).lastRoster?.name).toBe('Team')
    expect(theGroup(carol.ctx, ALICE_ID, conv.gid).lastRoster?.name).toBe('Team')
  })

  it('removes a member through a nonce clash on the keyring and on the roster replace', async () => {
    const { alice, bob, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(bob.ctx)
    await pollOnce(carol.ctx)
    const seen = new Set<string>()
    alice.chain.hook = (method) => {
      if ((method === 'createGroupDoc' || method === 'replaceGroupDoc') && !seen.has(method)) {
        seen.add(method)
        return { ok: false, failure: 'nonce', error: 'nonce already present at tip' }
      }
      return null
    }
    await removeMember(alice.ctx, conv, CAROL_ID)
    expect(seen).toEqual(new Set(['createGroupDoc', 'replaceGroupDoc']))
    // Each clash was retried after a backoff (the owner loop alone would re-run at once, re-reading everything).
    expect(alice.chain.sleeps).toHaveLength(2)
    expect(currentEpoch(conv)).toEqual({ b: 1, r: 0 })
    await pollOnce(carol.ctx)
    expect(theGroup(carol.ctx, ALICE_ID, conv.gid).removed).toBe(true)
  })
})

describe('joining is saved at once (§5.5)', () => {
  it('saves the self-state when a grant is accepted, so a reload after removal still shows the group as removed', async () => {
    const { ledger, alice, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    const before = ledger.selfStates.find((s) => bytesEqual(s.owner, CAROL_ID))?.revision ?? 0
    await pollOnce(carol.ctx)
    // No coalescing timer ran (manual scheduler): the join itself wrote the self-state.
    const saved = ledger.selfStates.find((s) => bytesEqual(s.owner, CAROL_ID))
    expect(saved?.revision ?? 0).toBeGreaterThan(before)

    await removeMember(alice.ctx, conv, CAROL_ID)
    // Carol reloads (a fresh device state, same chain): the group comes back from the self-state, marked removed.
    const reloaded = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await reloaded.ctx.store.load()
    await attachSaved(reloaded.ctx)
    await pollOnce(reloaded.ctx)
    const group = groupConv(reloaded.ctx, ALICE_ID, conv.gid)
    expect(group).not.toBeNull()
    expect(group?.removed).toBe(true)
  })

  it('saves a re-add key at once, so a reload does not find the member removed again', async () => {
    const { ledger, alice, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(carol.ctx)
    await removeMember(alice.ctx, conv, CAROL_ID)
    await pollOnce(carol.ctx)
    await addMember(alice.ctx, conv, CAROL_ID)
    await pollOnce(carol.ctx)
    await pollOnce(carol.ctx)
    expect(theGroup(carol.ctx, ALICE_ID, conv.gid).removed).toBe(false)

    // Alice's sweep deletes her 1:1 messages (the grants among them): after a reload Carol has only
    // her saved self-state to go on, so the re-add key must already be in it.
    ledger.messages = ledger.messages.filter((m) => !bytesEqual(m.ownerId, ALICE_ID))
    const reloaded = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await reloaded.ctx.store.load()
    await attachSaved(reloaded.ctx)
    await pollOnce(reloaded.ctx)
    expect(groupConv(reloaded.ctx, ALICE_ID, conv.gid)?.removed).toBe(false)
  })
})

describe('review regressions', () => {
  it('verifies an uncertain roster replace and re-applies the change when a competing write won (review #3)', async () => {
    const { ledger, alice, bob } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    const k01 = conv.keys.get({ b: 0, r: 1 })
    if (!k01) throw new Error('no key')
    // Alice's tablet adds Carol at (0, 1) in the same instant her phone adds Dave at (0, 1): the
    // tablet's replace wins, and the phone's broadcast is refused on chain but only times out here.
    const tabletRoster = await encryptRoster(k01, conv.gid, { b: 0, r: 1, name: 'Team', avatarRef: '', members: [ALICE_ID, BOB_ID, CAROL_ID], ended: false })
    let raced = false
    alice.chain.hook = (method) => {
      if (method !== 'replaceGroupDoc' || raced) return null
      raced = true
      const doc = ledger.groupDocs.find((d) => bytesEqual(d.handle, rosterHandle(conv.gid)))
      if (!doc) throw new Error('no roster')
      doc.blob = tabletRoster
      doc.revision += 1
      return { ok: true, id: doc.id, confirmed: false }
    }
    await addMember(alice.ctx, conv, DAVE_ID)
    alice.chain.hook = null
    expect(raced).toBe(true)
    // The phone re-ran the owner loop on the winning roster: Carol stays, Dave is added at (0, 2).
    expect(currentEpoch(conv)).toEqual({ b: 0, r: 2 })
    expect(conv.lastRoster && has(conv.lastRoster.members, CAROL_ID) && has(conv.lastRoster.members, DAVE_ID)).toBe(true)
    await pollOnce(alice.ctx)
    expect(conv.lastRoster && has(conv.lastRoster.members, CAROL_ID) && has(conv.lastRoster.members, DAVE_ID)).toBe(true)
    await pollOnce(bob.ctx)
    await pollOnce(bob.ctx)
    const bobGroup = theGroup(bob.ctx, ALICE_ID, conv.gid)
    expect(currentEpoch(bobGroup)).toEqual({ b: 0, r: 2 })
    expect(has(members(bobGroup, BOB_ID), DAVE_ID) && has(members(bobGroup, BOB_ID), CAROL_ID)).toBe(true)
  })

  it('re-reads a roster whose id and revision match but whose content does not (review #3)', async () => {
    const { ledger, alice } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    const k00 = conv.keys.get({ b: 0, r: 0 })
    if (!k00) throw new Error('no key')
    // Another owner device's roster sits at the same id and revision as this device's cached one.
    const doc = ledger.groupDocs.find((d) => bytesEqual(d.handle, rosterHandle(conv.gid)))
    if (!doc) throw new Error('no roster')
    doc.blob = await encryptRoster(k00, conv.gid, { b: 0, r: 0, name: 'Elsewhere', avatarRef: '', members: [ALICE_ID, BOB_ID], ended: false })
    await pollOnce(alice.ctx)
    expect(conv.lastRoster?.name).toBe('Elsewhere')
  })

  it('adopts an uncertain roster replace that did land without writing it again', async () => {
    const { ledger, alice } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID])
    alice.chain.unconfirmed = 1
    await renameGroup(alice.ctx, conv, 'Landed')
    expect(ledger.groupDocs[0].revision).toBe(2)
    expect(conv.roster?.revision).toBe(2)
    expect(conv.lastRoster?.name).toBe('Landed')
  })

  it('refuses a group send when the required freshness query fails (review #2)', async () => {
    const { ledger, alice, bob } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(bob.ctx)
    const bobGroup = theGroup(bob.ctx, ALICE_ID, conv.gid)
    // Alice removes Carol; Bob's last apply is older than the freshness window and his group query now fails.
    await removeMember(alice.ctx, conv, CAROL_ID)
    ledger.time += 60_000
    const groupDocs = bob.chain.groupDocs.bind(bob.chain)
    bob.chain.groupDocs = async () => {
      throw new Error('DAPI timeout')
    }
    const before = ledger.messages.length
    await expect(say(bob.ctx, bobGroup, 'secret')).rejects.toBeInstanceOf(SendError)
    expect(ledger.messages).toHaveLength(before)
    expect(currentEpoch(bobGroup)).toEqual({ b: 0, r: 0 })
    // Once the query works again the same send goes out, on the new base.
    bob.chain.groupDocs = groupDocs
    await say(bob.ctx, bobGroup, 'secret')
    expect(currentEpoch(bobGroup)).toEqual({ b: 1, r: 0 })
  })

  it('does not remove a re-added member because of the leave they sent before', async () => {
    const { alice, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(carol.ctx)
    await leaveGroup(carol.ctx, theGroup(carol.ctx, ALICE_ID, conv.gid))
    await pollOnce(alice.ctx) // removes Carol: base 1
    await addMember(alice.ctx, conv, CAROL_ID) // Carol is back on base 1
    // A fresh owner device reaches Carol's old leave (base 0) through history.
    const tablet = makeContext(alice.chain.ledger, ALICE_ID, ALICE_PRIV)
    await tablet.ctx.store.load()
    await attachSaved(tablet.ctx)
    const g = theGroup(tablet.ctx, ALICE_ID, conv.gid)
    g.open = true
    g.deepProbe = true
    await pollOnce(tablet.ctx)
    // Carol's old leave is held (history), but it is on base 0, so it queues nothing.
    await backfill(tablet.ctx, g, CAROL_ID, { w: weekOf(alice.chain.ledger.time), b: 0, r: 0, j: 0 })
    expect(timeline(g).some((m) => m.content.type === 'leave')).toBe(true)
    await pollOnce(tablet.ctx)
    expect(tablet.ctx.pendingLeaves.size).toBe(0)
    expect(has(members(g, ALICE_ID), CAROL_ID)).toBe(true)
  })

  it('keeps a re-added member in the group after a reload', async () => {
    const { ledger, alice, carol } = world()
    const { conv } = await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID])
    await pollOnce(carol.ctx)
    await removeMember(alice.ctx, conv, CAROL_ID)
    await pollOnce(carol.ctx)
    expect(theGroup(carol.ctx, ALICE_ID, conv.gid).removed).toBe(true)
    await addMember(alice.ctx, conv, CAROL_ID)
    await pollOnce(carol.ctx)
    expect(theGroup(carol.ctx, ALICE_ID, conv.gid).removed).toBe(false)
    await carol.ctx.store.flush()

    // Carol reloads: the saved entry must reach the new base without the (possibly swept) grant.
    const reloaded = makeContext(ledger, CAROL_ID, CAROL_PRIV)
    await reloaded.ctx.store.load()
    for (const entry of reloaded.ctx.store.groups()) attachGroup(reloaded.ctx, entry)
    ledger.messages = ledger.messages.filter((m) => !bytesEqual(m.ownerId, ALICE_ID))
    await pollOnce(reloaded.ctx)
    const g = theGroup(reloaded.ctx, ALICE_ID, conv.gid)
    expect(g.removed).toBe(false)
    expect(currentEpoch(g)).toEqual({ b: 1, r: 1 })
  })

  it('writes one self-state save when creating a group with several new contacts', async () => {
    const { ledger, alice } = world()
    let saves = 0
    const create = alice.chain.createSelfState.bind(alice.chain)
    const replace = alice.chain.replaceSelfState.bind(alice.chain)
    alice.chain.createSelfState = async (fields) => { saves++; return create(fields) }
    alice.chain.replaceSelfState = async (ref, fields) => { saves++; return replace(ref, fields) }
    await createGroup(alice.ctx, 'Team', [BOB_ID, CAROL_ID, DAVE_ID])
    expect(ledger.invites).toHaveLength(3)
    expect(saves).toBe(1)
  })
})
