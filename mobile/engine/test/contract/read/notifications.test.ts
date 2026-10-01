/**
 * notifications.* read-only against the live network: the engine reads a
 * public author's notifications as if they were the viewer. Notifications are
 * derived from public documents, so this needs no key and signs nothing;
 * only lib's notion of the current user is stubbed. Read state stays in the
 * engine's in-memory store.
 */
import { expect, it, vi } from 'vitest'
import { notificationDTO, page } from '../../../src/dto/validate'
import { describeRead, engine, expectCode, expectValid, namedAuthor, timed } from './harness'

const m = vi.hoisted(() => ({ viewer: null as string | null }))
vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))

describeRead('notifications', 'notifications', () => {
  it('lists a public author\'s last 7 days of notifications, tab by tab, and counts the unread', async () => {
    await expectCode(engine.notifications.list(), 'NOT_SIGNED_IN')
    m.viewer = (await namedAuthor()).id
    try {
      const all = await timed('notifications.list', () => engine.notifications.list({ filter: 'all' }), 'first: 7 days')
      expectValid(page(notificationDTO), all, 'all')
      const likes = await timed('notifications.list', () => engine.notifications.list({ filter: 'like' }), 'held')
      expectValid(page(notificationDTO), likes, 'likes')
      expect(likes.items.every(item => item.type === 'like')).toBe(true)
      const unread = await timed('notifications.unreadCount', () => engine.notifications.unreadCount())
      expect(unread).toBeGreaterThanOrEqual(0)
      const polled = await timed('notifications.poll', () => engine.notifications.poll())
      expect(polled.added).toBeGreaterThanOrEqual(0)
      await expectCode(engine.notifications.list({ filter: 'nope' as never }), 'BAD_REQUEST')
    } finally {
      m.viewer = null
    }
  })
})
