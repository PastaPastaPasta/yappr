import {
  checkAppConnectGroupTrust,
  type AppConnectGroupTrust,
  type AppConnectIdentityPort,
  type PinnedGroup,
} from 'platform-auth'
import type { AppConnectPins } from './config'

/**
 * Whether the app may offer App Connect login, and which pinned members a
 * group-bound key may sign for.
 *
 * The core check proves the group itself: owner, no admins, members exactly
 * the pinned set. A whole-contract membership also covers every document type
 * a member gains later, so each member contract must still be at its pinned
 * version (docs/APP_CONNECT_CONTRACTS.md, "Widening by update"). A member at
 * another version is treated like an unexpected member: new logins are
 * blocked, and the selector stops routing that contract to the group key.
 */

export interface MemberContractPort {
  /** The member contract's version and owner, from a proved read; null when it does not exist. */
  memberContract(contractId: string): Promise<{ version: number; ownerId: string } | null>
}

export type AppConnectTrust =
  | { ok: true; group: PinnedGroup }
  | {
      ok: false
      reason: Exclude<AppConnectGroupTrust, { ok: true }>['reason'] | 'member-version' | 'member-owner'
      /** Members still safe to sign for with an existing group key. */
      group: PinnedGroup
      /** Contract ids that failed a version or owner check. */
      contracts?: string[]
    }

export async function checkAppConnectTrust(
  port: Pick<AppConnectIdentityPort, 'groupInfo'> & MemberContractPort,
  pins: AppConnectPins,
): Promise<AppConnectTrust> {
  const groupTrust = await checkAppConnectGroupTrust(port, {
    groupId: pins.groupId,
    ownerId: pins.groupOwner,
    adminIds: [],
    members: pins.members.map((member) => ({ kind: 'contract', contractId: member.contractId })),
  })

  const contracts = await Promise.all(pins.members.map(async (member) => ({
    member,
    onChain: await port.memberContract(member.contractId),
  })))
  const badVersion = contracts.filter(({ member, onChain }) => onChain?.version !== member.version)
  const badOwner = contracts.filter(({ onChain }) => onChain !== null && onChain.ownerId !== pins.groupOwner)
  const failed = new Set([...badVersion, ...badOwner].map(({ member }) => member.contractId))
  // A pinned member the group lacks would be a paid out-of-bounds refusal (20014).
  if (!groupTrust.ok && groupTrust.reason === 'missing-members') {
    for (const member of groupTrust.members) failed.add(member.contractId)
  }
  // With no group, or one under a different owner or with admins, membership
  // was never checked and nothing about the group can be relied on: route
  // nothing to the group key.
  const failClosed = !groupTrust.ok
    && (groupTrust.reason === 'group-not-found' || groupTrust.reason === 'owner-mismatch' || groupTrust.reason === 'admins-mismatch')
  const group: PinnedGroup = {
    groupId: pins.groupId,
    members: failClosed
      ? []
      : pins.members
        .filter((member) => !failed.has(member.contractId))
        .map((member) => ({ kind: 'contract', contractId: member.contractId })),
  }

  if (!groupTrust.ok) return { ok: false, reason: groupTrust.reason, group }
  if (badVersion.length > 0) {
    return { ok: false, reason: 'member-version', group, contracts: badVersion.map(({ member }) => member.contractId) }
  }
  if (badOwner.length > 0) {
    return { ok: false, reason: 'member-owner', group, contracts: badOwner.map(({ member }) => member.contractId) }
  }
  return { ok: true, group }
}
