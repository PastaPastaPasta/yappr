import { describe, expect, it } from 'vitest'
import { toAppConnectIdentityKey, toAppConnectIdentityKeys, type WasmIdentityKeyLike } from './key-mapping'

const point = '02' + '11'.repeat(32)
const bounds = (json: { $type: string; id: string; documentTypeName?: string }) => ({ toJSON: () => json })

function key(overrides: Partial<WasmIdentityKeyLike> = {}): WasmIdentityKeyLike {
  return { keyId: 3, keyTypeNumber: 0, purposeNumber: 0, securityLevelNumber: 2, data: point, ...overrides }
}

describe('toAppConnectIdentityKey', () => {
  it('maps an unbound V0 key', () => {
    expect(toAppConnectIdentityKey(key())).toEqual({ id: 3, type: 0, purpose: 0, securityLevel: 2, data: Uint8Array.from(Buffer.from(point, 'hex')) })
  })

  it('maps each bounds kind and the V1 limits', () => {
    const mapped = toAppConnectIdentityKey(key({
      contractBounds: bounds({ $type: 'contractGroup', id: 'G' }),
      totalBudget: 5n,
      expiresAt: 10n,
      disabledAt: 7n,
    }))
    expect(mapped).toMatchObject({ bounds: { kind: 'contractGroup', groupId: 'G' }, totalBudget: 5n, expiresAt: 10, disabledAt: 7 })
    expect(toAppConnectIdentityKey(key({ contractBounds: bounds({ $type: 'singleContract', id: 'C' }) }))?.bounds)
      .toEqual({ kind: 'singleContract', contractId: 'C' })
    expect(toAppConnectIdentityKey(key({ contractBounds: bounds({ $type: 'documentType', id: 'C', documentTypeName: 'profile' }) }))?.bounds)
      .toEqual({ kind: 'documentType', contractId: 'C', documentTypeName: 'profile' })
  })

  it('refuses a key it cannot read faithfully, so an unknown bound never looks unbound', () => {
    expect(toAppConnectIdentityKey(key({ contractBounds: bounds({ $type: 'somethingNew', id: 'C' }) }))).toBeNull()
    expect(toAppConnectIdentityKey(key({ contractBounds: bounds({ $type: 'documentType', id: 'C' }) }))).toBeNull()
    expect(toAppConnectIdentityKey(key({ data: 42 }))).toBeNull()
    expect(toAppConnectIdentityKeys([key(), key({ keyId: 4, data: null })]).map((k) => k.id)).toEqual([3])
  })
})
