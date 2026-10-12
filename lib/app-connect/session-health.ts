import {
  APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS,
  boundsEqual,
  type AppConnectIdentityKey,
  type AppConnectSession,
  type AppConnectSessionKey,
} from 'platform-auth'
import { APP_CONNECT_RENEW_BUDGET_SHARE, APP_CONNECT_RENEW_WITHIN_MS } from './config'

/**
 * `ok`: nothing to say. `renew-soon`: the banner (under 20% of the allowance
 * or under 14 days left). `renew-required`: writes stop until the user renews
 * in their wallet; reads continue.
 */
export type AppConnectHealth = 'ok' | 'renew-soon' | 'renew-required'

/** The session's group key: the primary grant every Yappr write but the DashPay profile goes through. */
export function primaryGroupKey(session: AppConnectSession): AppConnectSessionKey | undefined {
  return session.authKeys.find((key) => key.bounds?.kind === 'contractGroup' && key.bounds.groupId === session.groupId)
}

export function appConnectHealth(session: AppConnectSession, now: number): AppConnectHealth {
  const key = primaryGroupKey(session)
  if (!key || key.disabled) return 'renew-required'
  if (key.expiresAt !== undefined && key.expiresAt - now <= APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS) return 'renew-required'
  if (key.totalBudget !== undefined) {
    if (key.remainingBudget === undefined) return 'ok'
    if (key.remainingBudget <= 0n) return 'renew-required'
    // remaining / total < share, in integers: remaining * 100 < total * share * 100.
    if (key.remainingBudget * 100n < key.totalBudget * BigInt(Math.round(APP_CONNECT_RENEW_BUDGET_SHARE * 100))) return 'renew-soon'
  }
  if (key.expiresAt !== undefined && key.expiresAt - now <= APP_CONNECT_RENEW_WITHIN_MS) return 'renew-soon'
  return 'ok'
}

/**
 * Compares the session with the identity's keys on chain. `revoked` when any
 * session key is gone, disabled, or no longer the key the session recorded
 * (the wallet revoked or superseded this browser's grant): the session must
 * be wiped. Otherwise the session with every key's chain state applied.
 */
export function reconcileSessionWithChain(
  session: AppConnectSession,
  chainKeys: readonly AppConnectIdentityKey[],
  budgets: ReadonlyMap<number, bigint | undefined>,
): { revoked: true } | { revoked: false; session: AppConnectSession } {
  const byId = new Map(chainKeys.map((key) => [key.id, key]))
  const live = (keyId: number) => {
    const key = byId.get(keyId)
    return key && key.disabledAt === undefined ? key : undefined
  }
  if (session.authKeys.some((key) => !live(key.keyId)) || session.encKeys.some((key) => !live(key.keyId))) {
    return { revoked: true }
  }
  for (const key of session.authKeys) {
    const chain = byId.get(key.keyId) as AppConnectIdentityKey
    const sameBounds = chain.bounds && key.bounds ? boundsEqual(chain.bounds, key.bounds) : chain.bounds === key.bounds
    if (!sameBounds || chain.securityLevel !== key.securityLevel) return { revoked: true }
  }
  return {
    revoked: false,
    session: {
      ...session,
      authKeys: session.authKeys.map((key) => {
        const chain = byId.get(key.keyId) as AppConnectIdentityKey
        return {
          ...key,
          totalBudget: chain.totalBudget,
          expiresAt: chain.expiresAt,
          remainingBudget: chain.totalBudget === undefined ? undefined : budgets.get(key.keyId) ?? key.remainingBudget,
        }
      }),
    },
  }
}

/**
 * Drops the session's encryption keys for `contractId` that are no longer the
 * identity's current key there: another wallet registered a newer one, which
 * peers now encrypt to. The session stops encrypting with the outdated key,
 * and the messaging prompts lead to renewing in the wallet, which brings the
 * current one. Returns null when nothing changed.
 */
export function withoutOutdatedEncryptionKeys(
  session: AppConnectSession,
  contractId: string,
  currentKeys: readonly AppConnectIdentityKey[],
): AppConnectSession | null {
  const current = new Set(currentKeys.map((key) => key.id))
  const encKeys = session.encKeys.filter((key) => key.contractId !== contractId || current.has(key.keyId))
  return encKeys.length === session.encKeys.length ? null : { ...session, encKeys }
}
