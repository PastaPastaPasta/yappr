/**
 * `notifications.*` with lib's notification service mocked: a first read
 * whose sources all failed soft must fail (NEW-R-vi-002), not settle on an
 * empty list that later reads never refill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Notification, User } from '@/lib/types'

const m = vi.hoisted(() => {
  const items = new Map<string, string>()
  // lib's notification store persists through localStorage, which Node lacks.
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, String(value)),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() { return items.size },
    },
  })
  return {
    viewer: 'viewer' as string | null,
    getInitialNotifications: vi.fn(),
    pollNewNotifications: vi.fn(),
  }
})

vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/services/notification-service', () => ({
  notificationService: { getInitialNotifications: m.getInitialNotifications, pollNewNotifications: m.pollNewNotifications },
}))
vi.mock('@/lib/services/block-service', () => ({ blockService: { checkBlockedBatch: async () => new Map() } }))
vi.mock('@/lib/services/unified-profile-service', async (load) => ({
  ...await load<object>(),
  unifiedProfileService: { getProfilesByIdentityIds: async () => [], getProfile: async () => null },
}))

const { createNotificationsModule } = await import('../../src/api/notifications')

const actor: User = { id: 'actor', username: 'actor', displayName: 'Actor', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) }
const follow = (id: string, at: number): Notification => ({ id, type: 'follow', from: actor, createdAt: new Date(at), read: false })
const quorumError = new Error('invalid quorum: Quorum not found in cache for hash: 00ab')

describe('notifications.list (NEW-R-vi-002)', () => {
  let notifications: ReturnType<typeof createNotificationsModule>
  beforeEach(() => {
    vi.clearAllMocks()
    m.viewer = 'viewer'
    notifications = createNotificationsModule(() => undefined)
  })

  it('fails a first read that found nothing because its sources failed, and reads again next time', async () => {
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [], latestTimestamp: 1_000, failure: quorumError })
    await expect(notifications.api.list()).rejects.toMatchObject({ message: expect.stringMatching(/quorum not found in cache/i) })

    // Not settled as "none": the retry (Try again, pull to refresh) reads the 7 days again.
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [follow('f1', 2_000)], latestTimestamp: 2_000 })
    const page = await notifications.api.list()
    expect(page.items.map(item => item.id)).toEqual(['f1'])
    expect(m.getInitialNotifications).toHaveBeenCalledTimes(2)
  })

  it('fails the poll that would load them too, so pull to refresh says so', async () => {
    m.getInitialNotifications.mockResolvedValue({ notifications: [], latestTimestamp: 1_000, failure: quorumError })
    await expect(notifications.api.poll()).rejects.toThrow(/quorum/i)
    expect(m.pollNewNotifications).not.toHaveBeenCalled()
  })

  it('shows what a partly failed first read found', async () => {
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [follow('f1', 2_000)], latestTimestamp: 1_000, failure: quorumError })
    expect((await notifications.api.list()).items.map(item => item.id)).toEqual(['f1'])
  })

  it('still answers an empty list when every source answered', async () => {
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [], latestTimestamp: 1_000 })
    expect((await notifications.api.list()).items).toEqual([])
  })
})
