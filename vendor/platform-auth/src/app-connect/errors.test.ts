import { describe, expect, it } from 'vitest'
import { classifyAppConnectError } from './errors'
import { checkAppConnectGroupTrust, type PinnedGroupTrust } from './group'
import type { AppConnectGroupInfo } from './types'

describe('classifyAppConnectError', () => {
  it('maps the key-ring consensus codes to actions', () => {
    const table = [20013, 20014, 20015, 20016, 40218, 20006, 40208, 20003].map((code) => {
      const c = classifyAppConnectError(code)
      return [code, c?.failure, c?.action, c?.paid]
    })
    expect(table).toEqual([
      [20013, 'bound-key-non-batch', 'handoff', false],
      [20014, 'out-of-bounds', 'invalidate', true],
      [20015, 'allowance-spent', 'renew', false],
      [20016, 'expired', 'renew', false],
      [40218, 'insufficient-allowance', 'renew', false],
      [20006, 'key-disabled', 'logout', false],
      [40208, 'key-disabled', 'logout', true],
      [20003, 'key-missing', 'logout', false],
    ])
  })

  it('returns null for anything else', () => {
    expect(classifyAppConnectError(null)).toBeNull()
    expect(classifyAppConnectError(undefined)).toBeNull()
    expect(classifyAppConnectError(40105)).toBeNull()
  })
})

describe('checkAppConnectGroupTrust', () => {
  const pinned: PinnedGroupTrust = {
    groupId: 'Group',
    ownerId: 'Owner',
    members: [
      { kind: 'contract', contractId: 'Anchor' },
      { kind: 'contract', contractId: 'Social' },
      { kind: 'documentType', contractId: 'Blog', documentTypeName: 'post' },
    ],
  }
  const onChain = (info: Partial<AppConnectGroupInfo>): AppConnectGroupInfo => ({
    ownerId: 'Owner',
    adminIds: [],
    members: [...pinned.members].reverse(),
    ...info,
  })
  const check = (info: AppConnectGroupInfo | null, trust = pinned) => checkAppConnectGroupTrust({ groupInfo: async () => info }, trust)

  it('accepts the pinned group in any member order', async () => {
    expect(await check(onChain({}))).toEqual({ ok: true })
  })

  it('blocks a missing group, a different owner or admins', async () => {
    expect(await check(null)).toEqual({ ok: false, reason: 'group-not-found' })
    expect(await check(onChain({ ownerId: 'Mallory' }))).toEqual({ ok: false, reason: 'owner-mismatch' })
    expect(await check(onChain({ adminIds: ['Mallory'] }))).toEqual({ ok: false, reason: 'admins-mismatch' })
    expect(await check(onChain({ adminIds: ['Ops'] }), { ...pinned, adminIds: ['Ops'] })).toEqual({ ok: true })
  })

  it('blocks a missing pinned member and an unexpected member', async () => {
    expect(await check(onChain({ members: pinned.members.slice(1) }))).toEqual({
      ok: false,
      reason: 'missing-members',
      members: [{ kind: 'contract', contractId: 'Anchor' }],
    })
    const extra = { kind: 'token' as const, contractId: 'Social', position: 0 }
    expect(await check(onChain({ members: [...pinned.members, extra] }))).toEqual({
      ok: false,
      reason: 'unexpected-members',
      members: [extra],
    })
  })
})
