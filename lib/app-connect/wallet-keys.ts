import { KeyPurpose, type AppConnectIdentityKey } from 'platform-auth'
import { DASHPAY_CONTRACT_ID, DASHPAY_PROFILE_DOCUMENT_TYPE } from './config'

export interface WalletKeyRow {
  keyId: number
  scope: 'yappr' | 'dash-profile'
  expiresAt?: number
  totalBudget?: bigint
  remaining?: bigint
  thisDevice: boolean
}

/** The identity's live keys a wallet granted to Yappr: the group key and the DashPay profile key. */
export function walletKeyRows(
  keys: readonly AppConnectIdentityKey[],
  budgets: ReadonlyMap<number, bigint | undefined>,
  groupId: string,
  thisDeviceKeyIds: ReadonlySet<number>,
): WalletKeyRow[] {
  return keys
    .filter((key) => key.purpose === KeyPurpose.AUTHENTICATION && key.disabledAt === undefined)
    .flatMap((key): WalletKeyRow[] => {
      const bounds = key.bounds
      const scope = bounds?.kind === 'contractGroup' && bounds.groupId === groupId
        ? 'yappr'
        : bounds?.kind === 'documentType' && bounds.contractId === DASHPAY_CONTRACT_ID && bounds.documentTypeName === DASHPAY_PROFILE_DOCUMENT_TYPE
          ? 'dash-profile'
          : null
      if (!scope) return []
      return [{
        keyId: key.id,
        scope,
        expiresAt: key.expiresAt,
        totalBudget: key.totalBudget,
        remaining: budgets.get(key.id),
        thisDevice: thisDeviceKeyIds.has(key.id),
      }]
    })
    .sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice) || b.keyId - a.keyId)
}
