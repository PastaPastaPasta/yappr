/**
 * The moderator view changes what a count sums (every lane, or the listed one),
 * so an in-flight count is never shared across a change of view: a caller
 * under the new view reads for itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { count } = vi.hoisted(() => ({ count: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { count } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))

import { setModeratorViewContracts } from '@/lib/moderation-view'
import { postService } from './post-service'

afterEach(() => {
  setModeratorViewContracts([])
  count.mockReset()
})

describe('in-flight counts across a moderator view change', () => {
  it('starts a fresh count instead of joining one read under the other view', async () => {
    let answer: (value: Map<string, bigint>) => void = () => undefined
    count.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const before = postService.countAllPosts()
    await vi.waitFor(() => expect(count).toHaveBeenCalledTimes(1))

    setModeratorViewContracts(['social'])
    count.mockResolvedValueOnce(new Map([['', 7n]]))
    const after = postService.countAllPosts()
    await expect(after).resolves.toBe(7)
    expect(count).toHaveBeenCalledTimes(2)

    answer(new Map([['', 3n]]))
    await expect(before).resolves.toBe(3)
  })

  it('still shares a count in flight within one view', async () => {
    count.mockResolvedValue(new Map([['', 4n]]))
    const [a, b] = await Promise.all([postService.countUserPosts('author'), postService.countUserPosts('author')])
    expect([a, b]).toEqual([4, 4])
    expect(count).toHaveBeenCalledTimes(1)
  })
})
