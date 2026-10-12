import type { AppConnectGroupMember, AppConnectIdentityPort, PinnedGroup } from './types'

/**
 * A group-bound key may sign for every member the group ever gains, and the
 * selector routes writes by the members pinned in config. So before offering
 * App Connect login the app proves the group on chain is exactly what it
 * pinned: the expected owner, the expected admins (none, for Yappr), every
 * pinned member present and no member it did not expect.
 */

export interface PinnedGroupTrust extends PinnedGroup {
  ownerId: string
  /** Defaults to none. */
  adminIds?: string[]
}

export type AppConnectGroupTrust =
  | { ok: true }
  | { ok: false; reason: 'group-not-found' | 'owner-mismatch' | 'admins-mismatch' }
  | { ok: false; reason: 'missing-members' | 'unexpected-members'; members: AppConnectGroupMember[] }

function memberKey(member: AppConnectGroupMember): string {
  switch (member.kind) {
    case 'contract':
      return `contract:${member.contractId}`
    case 'documentType':
      return `documentType:${member.contractId}:${member.documentTypeName}`
    case 'token':
      return `token:${member.contractId}:${member.position}`
  }
}

export async function checkAppConnectGroupTrust(
  port: Pick<AppConnectIdentityPort, 'groupInfo'>,
  pinned: PinnedGroupTrust,
): Promise<AppConnectGroupTrust> {
  const info = await port.groupInfo(pinned.groupId)
  if (!info) return { ok: false, reason: 'group-not-found' }
  if (info.ownerId !== pinned.ownerId) return { ok: false, reason: 'owner-mismatch' }

  const pinnedAdmins = new Set(pinned.adminIds ?? [])
  if (info.adminIds.length !== pinnedAdmins.size || info.adminIds.some((id) => !pinnedAdmins.has(id))) {
    return { ok: false, reason: 'admins-mismatch' }
  }

  const onChain = new Set(info.members.map(memberKey))
  const missing = pinned.members.filter((member) => !onChain.has(memberKey(member)))
  if (missing.length > 0) return { ok: false, reason: 'missing-members', members: missing }

  const expected = new Set(pinned.members.map(memberKey))
  const unexpected = info.members.filter((member) => !expected.has(memberKey(member)))
  if (unexpected.length > 0) return { ok: false, reason: 'unexpected-members', members: unexpected }

  return { ok: true }
}
