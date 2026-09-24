import { describe, expect, it } from 'vitest'
import { checkGrant } from './grant'
import { ALICE_ID, BOB_ID, CAROL_ID, key32, unhex } from './test-fixtures'
import type { GroupGrant, OpenedRoster } from './types'

const grant: GroupGrant = { gid: unhex('36bcf5d162c4be1412d2'), b: 0, r: 2, key: key32(1) }
const roster = (b: number, r: number, members = [ALICE_ID, BOB_ID]): OpenedRoster => ({
  content: { b, r, name: 'g', avatarRef: '', members, ended: false, epochLog: [] },
  key: key32(2),
})
// Alice (the owner) grants Bob on her 1:1 stream; Bob checks it.
const base = { grant, streamSender: ALICE_ID, rosterOwner: ALICE_ID, roster: roster(0, 2), memberId: BOB_ID }

describe('grant acceptance (§6.2)', () => {
  it('accepts a grant from the roster owner whose roster lists the member', () => {
    expect(checkGrant(base)).toEqual({ accepted: true })
  })

  it('accepts when the roster has moved on by ratchet or a newer keyring', () => {
    expect(checkGrant({ ...base, roster: roster(0, 5) })).toEqual({ accepted: true })
    expect(checkGrant({ ...base, roster: roster(1, 0) })).toEqual({ accepted: true })
  })

  it('rejects a forwarded key: the stream sender does not own the roster', () => {
    expect(checkGrant({ ...base, streamSender: CAROL_ID })).toEqual({ accepted: false, reason: 'wrong-owner' })
  })

  it('rejects a grant on the member’s own stream', () => {
    expect(checkGrant({ ...base, streamSender: BOB_ID, rosterOwner: BOB_ID })).toEqual({ accepted: false, reason: 'own-stream' })
  })

  it('rejects when the roster does not decrypt with the granted key', () => {
    expect(checkGrant({ ...base, roster: null })).toEqual({ accepted: false, reason: 'roster-unreadable' })
  })

  it('rejects a roster behind the granted epoch', () => {
    expect(checkGrant({ ...base, roster: roster(0, 1) })).toEqual({ accepted: false, reason: 'stale-roster' })
  })

  it('rejects a grant to an ended group', () => {
    const ended = roster(0, 2)
    expect(checkGrant({ ...base, roster: { ...ended, content: { ...ended.content, ended: true } } })).toEqual({ accepted: false, reason: 'ended' })
  })

  it('rejects when the roster does not list the member', () => {
    expect(checkGrant({ ...base, roster: roster(0, 2, [ALICE_ID, CAROL_ID]) })).toEqual({ accepted: false, reason: 'not-a-member' })
  })
})
