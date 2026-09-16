import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
import { followService } from './follow-service'

beforeEach(() => query.mockReset())

describe('connection list read failures', () => {
  for (const method of ['getFollowing', 'getFollowers'] as const) {
    it(`${method} distinguishes a failed read from a successful empty list`, async () => {
      query.mockRejectedValueOnce(new Error('offline'))
      await expect(followService[method]('111111111', { throwOnError: true })).rejects.toThrow('offline')

      query.mockResolvedValueOnce([])
      await expect(followService[method]('111111111', { throwOnError: true })).resolves.toEqual([])
    })

    it(`${method} preserves the legacy fallback for callers that do not opt in`, async () => {
      query.mockRejectedValueOnce(new Error('offline'))
      await expect(followService[method]('111111111')).resolves.toEqual([])
    })
  }
})
