import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import type { AppConnectGroupInfo } from 'platform-auth'
import { checkAppConnectTrust } from './group-trust'

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const APP = id(1)
const SOCIAL = id(2)
const BLOG = id(3)
const OWNER = id(9)
const GROUP = id(8)
const pins = {
  appId: APP,
  groupId: GROUP,
  groupOwner: OWNER,
  members: [{ contractId: APP, version: 1 }, { contractId: SOCIAL, version: 1 }, { contractId: BLOG, version: 1 }],
}

function port(info: AppConnectGroupInfo | null, versions: Record<string, number> = {}, owners: Record<string, string> = {}) {
  return {
    groupInfo: async () => info,
    memberContract: async (contractId: string) =>
      versions[contractId] === 0 ? null : { version: versions[contractId] ?? 1, ownerId: owners[contractId] ?? OWNER },
  }
}

const members = (...ids: string[]) => ids.map((contractId) => ({ kind: 'contract' as const, contractId }))
const healthy: AppConnectGroupInfo = { ownerId: OWNER, adminIds: [], members: members(APP, SOCIAL, BLOG) }

describe('checkAppConnectTrust', () => {
  it('trusts the pinned group with every member at its pinned version', async () => {
    expect(await checkAppConnectTrust(port(healthy), pins)).toEqual({ ok: true, group: { groupId: GROUP, members: members(APP, SOCIAL, BLOG) } })
  })

  it('blocks logins on a member updated past its pinned version and stops routing it to the group key', async () => {
    const trust = await checkAppConnectTrust(port(healthy, { [BLOG]: 2 }), pins)
    expect(trust).toMatchObject({ ok: false, reason: 'member-version', contracts: [BLOG] })
    expect(trust.group.members).toEqual(members(APP, SOCIAL))
  })

  it('treats a member that cannot be read as failing its version', async () => {
    const trust = await checkAppConnectTrust(port(healthy, { [SOCIAL]: 0 }), pins)
    expect(trust).toMatchObject({ ok: false, reason: 'member-version', contracts: [SOCIAL] })
  })

  it('blocks logins on a member owned by someone else', async () => {
    const trust = await checkAppConnectTrust(port(healthy, {}, { [SOCIAL]: id(7) }), pins)
    expect(trust).toMatchObject({ ok: false, reason: 'member-owner', contracts: [SOCIAL] })
    expect(trust.group.members).toEqual(members(APP, BLOG))
  })

  it('blocks logins on an unexpected member but keeps signing for the pinned ones', async () => {
    const trust = await checkAppConnectTrust(port({ ...healthy, members: members(APP, SOCIAL, BLOG, id(6)) }), pins)
    expect(trust).toMatchObject({ ok: false, reason: 'unexpected-members' })
    expect(trust.group.members).toEqual(members(APP, SOCIAL, BLOG))
  })

  it('never routes a pinned member the group lacks to the group key', async () => {
    const trust = await checkAppConnectTrust(port({ ...healthy, members: members(APP, SOCIAL) }), pins)
    expect(trust).toMatchObject({ ok: false, reason: 'missing-members' })
    expect(trust.group.members).toEqual(members(APP, SOCIAL))
  })

  it('routes nothing when the group does not exist, and blocks on a foreign owner or an admin', async () => {
    const missing = await checkAppConnectTrust(port(null), pins)
    expect(missing).toMatchObject({ ok: false, reason: 'group-not-found' })
    expect(missing.group.members).toEqual([])
    const foreignOwner = await checkAppConnectTrust(port({ ...healthy, ownerId: id(7) }), pins)
    expect(foreignOwner).toMatchObject({ ok: false, reason: 'owner-mismatch' })
    expect(foreignOwner.group.members).toEqual([])
    const withAdmin = await checkAppConnectTrust(port({ ...healthy, adminIds: [id(7)] }), pins)
    expect(withAdmin).toMatchObject({ ok: false, reason: 'admins-mismatch' })
    expect(withAdmin.group.members).toEqual([])
  })
})
