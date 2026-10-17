import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSettings } from '@/lib/store'
import type { Notification } from '@/lib/types'
import { getVisibleUnreadNotificationCount } from '@/lib/notification-preferences'
import { useNotificationStore, withoutBlockedActors } from './notification-store'

// The store persists readIds through localStorage, which the node test
// environment lacks. It must exist before the store module is evaluated.
const storage = vi.hoisted(() => {
  const items = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true })
  return items
})

function persistedReadIds(): string[] {
  const raw = storage.get('yappr-notifications')
  return raw ? (JSON.parse(raw) as { state: { readIds: string[] } }).state.readIds : []
}

const enabled: NotificationSettings = {
  likes: true, reposts: true, replies: true, follows: true,
  mentions: true, messages: true, blogPosts: true, store: true,
}

function notification(id: string, type: Notification['type'], createdAt: number): Notification {
  return {
    id,
    type,
    from: { id: `from-${id}` } as Notification['from'],
    createdAt: new Date(createdAt),
    read: false,
  }
}

const store = () => useNotificationStore.getState()

describe('markAllAsRead', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], readIds: [] })
    store().setNotifications([
      notification('like-1', 'like', 5),
      notification('follow-1', 'follow', 4),
      notification('comment-1', 'blogComment', 3),
      notification('request-1', 'privateFeedRequest', 2),
      notification('like-2', 'like', 1),
    ])
  })

  it('marks only notifications of enabled types as read', () => {
    const likesOff = { ...enabled, likes: false }
    store().markAllAsRead(likesOff)

    const readById = Object.fromEntries(store().notifications.map(n => [n.id, n.read]))
    expect(readById).toEqual({
      'like-1': false, 'follow-1': true, 'comment-1': true, 'request-1': true, 'like-2': false,
    })
    expect(new Set(store().readIds)).toEqual(new Set(['follow-1', 'comment-1', 'request-1']))
    expect(new Set(persistedReadIds())).toEqual(new Set(['follow-1', 'comment-1', 'request-1']))
    expect(getVisibleUnreadNotificationCount(store().notifications, likesOff)).toBe(0)
  })

  it('leaves hidden notifications unread when their type is re-enabled', () => {
    store().markAllAsRead({ ...enabled, likes: false, blogPosts: false })
    expect(getVisibleUnreadNotificationCount(store().notifications, enabled)).toBe(3)
  })

  it('keeps hidden notifications unread across a refetch', () => {
    store().markAllAsRead({ ...enabled, likes: false })
    // A fresh fetch rebuilds read flags from the persisted readIds alone.
    store().setNotifications(store().notifications.map(n => ({ ...n, read: false })))
    const unread = store().notifications.filter(n => !n.read).map(n => n.id)
    expect(unread).toEqual(['like-1', 'like-2'])
  })

  it('always marks private feed events, which have no preference', () => {
    const allOff = Object.fromEntries(Object.keys(enabled).map(key => [key, false])) as unknown as NotificationSettings
    store().markAllAsRead(allOff)
    expect(store().readIds).toEqual(['request-1'])
  })

  it('marks everything when every type is enabled', () => {
    store().markAllAsRead(enabled)
    expect(store().notifications.every(n => n.read)).toBe(true)
    expect(store().readIds).toHaveLength(5)
  })
})

describe('removeFromActor', () => {
  it('drops one actor\'s notifications and keeps the rest', () => {
    useNotificationStore.setState({ notifications: [], readIds: [] })
    store().setNotifications([notification('a', 'like', 3), notification('b', 'follow', 2)])
    store().removeFromActor('from-a')
    expect(store().notifications.map(n => n.id)).toEqual(['b'])
  })

  it('takes just the blocked liker out of an aggregated like, and the like only when no liker is left', () => {
    const user = (id: string) => ({ id }) as Notification['from']
    const batch = (id: string, likers: string[], likerCount: number): Notification => ({
      ...notification(id, 'like', 1), from: user(likers[0]), likers: likers.map(user), likerCount, timeless: true,
    })
    useNotificationStore.setState({ notifications: [], readIds: [] })
    store().setNotifications([batch('both', ['alice', 'bob'], 3), batch('alone', ['alice'], 1)])

    store().removeFromActor('alice')

    expect(store().notifications.map(({ id, from, likers, likerCount }) => ({ id, from: from.id, likers: likers?.map(l => l.id), likerCount })))
      .toEqual([{ id: 'both', from: 'bob', likers: ['bob'], likerCount: 2 }])
  })
})

describe('withoutBlockedActors', () => {
  const user = (id: string) => ({ id }) as Notification['from']
  const batch: Notification = { ...notification('b', 'like', 1), from: user('alice'), likers: [user('alice'), user('bob'), user('carol')], likerCount: 5 }

  it('leaves a notification untouched when no one in it is blocked', () => {
    expect(withoutBlockedActors(batch, () => false)).toBe(batch)
  })

  it('lowers the count by the blocked likers and shows the first one left', () => {
    const shown = withoutBlockedActors(batch, (id) => id !== 'carol')
    expect(shown && { from: shown.from.id, likers: shown.likers?.map(l => l.id), likerCount: shown.likerCount })
      .toEqual({ from: 'carol', likers: ['carol'], likerCount: 3 })
  })
})
