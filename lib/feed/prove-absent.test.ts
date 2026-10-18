import { describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/services/document-service', () => ({ queryRawDocuments: query }))
import { provenAbsent } from './prove-absent'

describe('missing-parent proofs', () => {
  it('distinguishes unproven absence from a failed strict thread read', async () => {
    query.mockRejectedValue(new Error('DAPI unavailable'))
    expect(await provenAbsent('reply', ['parent'])).toEqual(new Set())
    await expect(provenAbsent('reply', ['parent'], { throwOnError: true })).rejects.toThrow('DAPI unavailable')
    query.mockResolvedValue([])
    expect(await provenAbsent('reply', ['parent'], { throwOnError: true })).toEqual(new Set(['parent']))
    query.mockResolvedValue([{ $id: 'parent' }])
    expect(await provenAbsent('reply', ['parent'], { throwOnError: true })).toEqual(new Set())
  })
})
