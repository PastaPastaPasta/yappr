// Pure build configuration validation shared by browser login and read-only monitoring.
import bs58 from 'bs58'

export const APP_CONNECT_DEFAULT_MEMBER_VERSION = 1

function isIdentifier(value) {
  try {
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}

/** @param {{ appId?: string, groupId?: string, groupOwner?: string, members?: string }} env */
export function parseAppConnectPins(env) {
  const appId = env.appId?.trim() ?? ''
  const groupId = env.groupId?.trim() ?? ''
  const groupOwner = env.groupOwner?.trim() ?? ''
  if (![appId, groupId, groupOwner].every(isIdentifier)) return null

  const members = []
  for (const entry of (env.members ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [contractId, versionText, extra] = entry.split(':')
    if (extra !== undefined || !isIdentifier(contractId)) return null
    const version = versionText === undefined ? APP_CONNECT_DEFAULT_MEMBER_VERSION : Number(versionText)
    if (!Number.isSafeInteger(version) || version < 1) return null
    if (members.some((member) => member.contractId === contractId)) return null
    members.push({ contractId, version })
  }
  if (!members.some((member) => member.contractId === appId)) return null
  return { appId, groupId, groupOwner, members }
}

