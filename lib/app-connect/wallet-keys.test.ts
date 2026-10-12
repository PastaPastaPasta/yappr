import { describe, expect, it } from 'vitest'
import type { AppConnectIdentityKey } from 'platform-auth'
import { DASHPAY_CONTRACT_ID } from './config'
import { walletKeyRows } from './wallet-keys'

const key = (overrides: Partial<AppConnectIdentityKey>): AppConnectIdentityKey => ({
  id: 1, type: 0, purpose: 0, securityLevel: 2, data: new Uint8Array(33), ...overrides,
})

describe('walletKeyRows', () => {
  const keys = [
    key({ id: 1 }),
    key({ id: 4, securityLevel: 1, bounds: { kind: 'contractGroup', groupId: 'group' }, totalBudget: 100n, expiresAt: 5 }),
    key({ id: 5, bounds: { kind: 'documentType', contractId: DASHPAY_CONTRACT_ID, documentTypeName: 'profile' }, totalBudget: 10n }),
    key({ id: 6, bounds: { kind: 'contractGroup', groupId: 'group' }, disabledAt: 3 }),
    key({ id: 7, bounds: { kind: 'contractGroup', groupId: 'other' } }),
    key({ id: 8, purpose: 1, bounds: { kind: 'singleContract', contractId: 'app' } }),
    key({ id: 9, bounds: { kind: 'contractGroup', groupId: 'group' }, totalBudget: 100n }),
  ]

  it('lists the live Yappr group and DashPay profile keys, this browser first', () => {
    const rows = walletKeyRows(keys, new Map([[4, 40n], [5, 9n]]), 'group', new Set([4, 5]))
    expect(rows.map((row) => [row.keyId, row.scope, row.thisDevice])).toEqual([
      [5, 'dash-profile', true],
      [4, 'yappr', true],
      [9, 'yappr', false],
    ])
    expect(rows[1]).toMatchObject({ remaining: 40n, totalBudget: 100n, expiresAt: 5 })
  })
})
