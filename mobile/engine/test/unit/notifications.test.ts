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
    blocked: new Set<string>(),
  }
})

vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/services/notification-service', () => ({
  notificationService: { getInitialNotifications: m.getInitialNotifications, pollNewNotifications: m.pollNewNotifications },
}))
vi.mock('@/lib/services/block-service', () => ({ blockService: { checkBlockedBatch: async (_viewer: string, ids: string[]) => new Map(ids.map(id => [id, m.blocked.has(id)])) } }))
vi.mock('@/lib/services/unified-profile-service', async (load) => ({
  ...await load<object>(),
  unifiedProfileService: { getProfilesByIdentityIds: async () => [], getProfile: async () => null },
}))

const { createNotificationsModule } = await import('../../src/api/notifications')
const { validate, page: pageOf, notificationDTO } = await import('../../src/dto/validate')

const actor: User = { id: 'actor', username: 'actor', displayName: 'Actor', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) }
const follow = (id: string, at: number): Notification => ({ id, type: 'follow', from: actor, createdAt: new Date(at), read: false })
const quorumError = new Error('invalid quorum: Quorum not found in cache for hash: 00ab')

describe('notifications.list (NEW-R-vi-002)', () => {
  let notifications: ReturnType<typeof createNotificationsModule>
  beforeEach(() => {
    vi.clearAllMocks()
    m.viewer = 'viewer'
    m.blocked = new Set()
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

  it('answers NOT_SIGNED_IN, not the read error, for an account that left while its failed load ran', async () => {
    m.getInitialNotifications.mockImplementationOnce(async () => {
      m.viewer = 'next'
      return { notifications: [], latestTimestamp: 1_000, failure: quorumError }
    })
    await expect(notifications.api.list()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
  })

  it('still answers an empty list when every source answered', async () => {
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [], latestTimestamp: 1_000 })
    expect((await notifications.api.list()).items).toEqual([])
  })
})

describe('notifications from blocked actors', () => {
  it('hides a held actor once the viewer blocks them, and counts them out of the badge', async () => {
    m.viewer = 'viewer'
    m.blocked = new Set()
    const notifications = createNotificationsModule(() => undefined)
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [follow('f1', 2_000)], latestTimestamp: 2_000 })
    expect((await notifications.api.list()).items.map(item => item.id)).toEqual(['f1'])

    m.blocked = new Set(['actor'])
    expect((await notifications.api.list()).items).toEqual([])
    expect(await notifications.api.unreadCount()).toBe(0)
  })
  it('takes just the blocked liker out of an aggregated like, whichever of them it is', async () => {
    const user = (id: string): User => ({ ...actor, id, username: id, displayName: id })
    const batch: Notification = {
      id: 'like:post:P1:1', type: 'like', from: user('alice'), likers: [user('alice'), user('bob')], likerCount: 2,
      timeless: true, createdAt: new Date(1_000), read: false,
    }
    const shown = async () => (await notifications.api.list()).items.map(item => ({ id: item.id, actor: item.actor.id, likers: item.likers }))
    m.viewer = 'viewer'
    m.blocked = new Set()
    const notifications = createNotificationsModule(() => undefined)
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [batch], latestTimestamp: 1_000 })
    expect(await shown()).toEqual([{ id: batch.id, actor: 'alice', likers: 2 }])

    m.blocked = new Set(['alice'])
    expect(await shown()).toEqual([{ id: batch.id, actor: 'bob', likers: undefined }])
    expect(await notifications.api.unreadCount()).toBe(1)

    m.blocked = new Set(['bob'])
    expect(await shown()).toEqual([{ id: batch.id, actor: 'alice', likers: undefined }])

    m.blocked = new Set(['alice', 'bob'])
    expect(await shown()).toEqual([])
    expect(await notifications.api.unreadCount()).toBe(0)
  })
})

describe('store notifications', () => {
  let notifications: ReturnType<typeof createNotificationsModule>
  beforeEach(() => {
    vi.clearAllMocks()
    m.viewer = 'viewer'
    notifications = createNotificationsModule(() => undefined)
  })

  it('word a store event as web does, open it on the web, and list it under the Store filter', async () => {
    const seller: User = { ...actor, id: '7sGmWnXr4iaMvzKTsqbJFMmMyDeBHJ4zqCYv7Bg94134' }
    const shipped: Notification = {
      id: 'orderStatus-u1', type: 'orderStatus', from: seller, createdAt: new Date(3_000), read: false,
      store: { status: 'shipped', text: 'On its way' },
    }
    const review: Notification = {
      id: 'storeReview-r1', type: 'storeReview', from: seller, createdAt: new Date(2_000), read: false,
      store: { storeId: 'S', rating: 4 },
    }
    m.getInitialNotifications.mockResolvedValueOnce({ notifications: [shipped, review, follow('f1', 1_000)], latestTimestamp: 3_000 })

    const page = await notifications.api.list({ filter: 'store' })

    expect(page.items.map(item => [item.id, item.target, item.store])).toEqual([
      ['orderStatus-u1', null, { phrase: 'shipped your order', snippet: 'On its way', path: '/orders' }],
      ['storeReview-r1', null, { phrase: 'reviewed your store', snippet: '★★★★☆', path: '/store/view?id=S' }],
    ])
    expect(validate(pageOf(notificationDTO), page)).toEqual([])
  })
})
