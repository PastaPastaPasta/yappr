/**
 * v13 moves `block`, `blockFilter` and `blockFollow` to the standalone blocks
 * contract (`NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID`). Every block read and
 * write goes there; a v13 deployment without one blocks nobody and refuses
 * block writes without touching the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

const { query, createDocument, deleteDocument, updateDocument } = vi.hoisted(() => ({
  query: vi.fn(), createDocument: vi.fn(), deleteDocument: vi.fn(), updateDocument: vi.fn(),
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument, deleteDocument, updateDocument } }))

const identity = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 1)))
const VIEWER = identity(1)
const TARGET = identity(2)
const BLOCKS = identity(9)
const SOCIAL = identity(8)

beforeEach(() => {
  vi.resetModules()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', {})
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  query.mockReset().mockResolvedValue([])
  createDocument.mockReset().mockResolvedValue({ success: true })
  deleteDocument.mockReset().mockResolvedValue({ success: true })
  updateDocument.mockReset().mockResolvedValue({ success: true })
  vi.stubEnv('NEXT_PUBLIC_YAPPR_CONTRACT_ID', SOCIAL)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function blockServiceOn(topology: string, blocksContractId: string) {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  vi.stubEnv('NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID', blocksContractId)
  return (await import('./block-service')).blockService
}

describe('blocks on v13', () => {
  it('reads and writes block, blockFilter and blockFollow in the blocks contract', async () => {
    const blockService = await blockServiceOn('v13', BLOCKS)
    await blockService.blockUser(VIEWER, TARGET)
    await blockService.getBloomFilter(VIEWER)
    await blockService.getBlockFollow(VIEWER)

    expect(new Set(query.mock.calls.map(([q]) => q.dataContractId))).toEqual(new Set([BLOCKS]))
    expect(new Set(query.mock.calls.map(([q]) => q.documentTypeName))).toEqual(new Set(['block', 'blockFilter', 'blockFollow']))
    expect(createDocument.mock.calls.map(([contract, type]) => [contract, type])).toEqual([[BLOCKS, 'block'], [BLOCKS, 'blockFilter']])
  })

  it('blocks nobody and refuses block writes when no blocks contract is configured', async () => {
    const blockService = await blockServiceOn('v13', '')
    await expect(blockService.getUserBlocks(VIEWER)).resolves.toEqual([])
    await expect(blockService.getBloomFilter(VIEWER)).resolves.toBeNull()
    await expect(blockService.getBlockFollow(VIEWER)).resolves.toBeNull()
    await expect(blockService.isBlocked(TARGET, VIEWER)).resolves.toBe(false)
    expect((await blockService.blockUser(VIEWER, TARGET)).success).toBe(false)
    expect((await blockService.unblockUser(VIEWER, TARGET)).success).toBe(false)
    expect((await blockService.followUserBlocks(VIEWER, TARGET)).success).toBe(false)
    expect(query).not.toHaveBeenCalled()
    expect(createDocument).not.toHaveBeenCalled()
  })

  it('keeps blocks in the social contract before v13, whatever the blocks setting says', async () => {
    const blockService = await blockServiceOn('v12', BLOCKS)
    await blockService.blockUser(VIEWER, TARGET)
    expect(new Set(query.mock.calls.map(([q]) => q.dataContractId))).toEqual(new Set([SOCIAL]))
    expect(createDocument.mock.calls[0][0]).toBe(SOCIAL)
  })
})
