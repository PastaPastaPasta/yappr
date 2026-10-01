import { getVisibleUnreadNotificationCount, isNotificationEnabled } from '@/lib/notification-preferences'
import { notificationService } from '@/lib/services/notification-service'
import { useSettingsStore } from '@/lib/store'
import { useNotificationStore } from '@/lib/stores/notification-store'
import type { Notification } from '@/lib/types'
import { truncateId } from '@/lib/utils/common'
import { RpcError } from '../protocol/envelope'
import { cursorString, decodeCursor } from '../dto/cursor'
import { avatarsOf, badRequest, requireViewer, viewerId } from '../dto/hydrate'
import { nextPage } from '../dto/paging'
import { toPostDTO, toUserSummaryDTO, type AuthorDTO, type Page, type PostDTO } from './dto'

/**
 * Notifications (ENGINE.md §6.3), derived on the device from documents by
 * `lib/services/notification-service.ts`, with read state in web's own
 * `yappr-notifications` zustand store (`lib/stores/notification-store.ts`;
 * read ids and the poll watermark persist, per account through the session
 * stash). The sidebar's loop (`components/layout/sidebar.tsx`) becomes
 * `poll()`, which RN calls every 30 s while foregrounded.
 */

/** `app/notifications/page.tsx`'s tabs. */
export type NotificationFilter = 'all' | 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'blogPost' | 'privateFeed'

export interface NotificationDTO {
  id: string
  type: Notification['type']
  actor: AuthorDTO
  at: Date
  read: boolean
  /**
   * The post or reply it is about (likes, reposts, quotes, replies,
   * mentions); `null` for follows and private-feed events. A v2 reply
   * notification opens its parent (`preview.parentId`), as web links it.
   */
  target: { id: string; kind: 'post' | 'reply' } | null
  preview: PostDTO | null
  /** Blog events (shown under All with "View on web"; blogs are not in 1.0). */
  blog?: { blogId: string; slug: string }
}

export interface NotificationCountEvent {
  unread: number
}

const FILTERS: readonly NotificationFilter[] = ['all', 'follow', 'mention', 'like', 'repost', 'reply', 'blogPost', 'privateFeed']
const PAGE = 30

/** `app/notifications/page.tsx` `getFilteredByTab`. */
function inTab(notification: Notification, filter: NotificationFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'privateFeed': return notification.type.startsWith('privateFeed')
    // The Blog tab covers new posts and comments on yours; v10 quotes share the Reposts tab (one slot on chain).
    case 'blogPost': return notification.type === 'blogPost' || notification.type === 'blogComment'
    case 'repost': return notification.type === 'repost' || notification.type === 'quote'
    default: return notification.type === filter
  }
}

const store = () => useNotificationStore.getState()
const settings = () => useSettingsStore.getState().notificationSettings

/** The list, tab counts and badge share one visibility rule: types turned off in settings are hidden. */
const visible = () => store().notifications.filter(notification => isNotificationEnabled(notification, settings()))
const unreadCount = () => getVisibleUnreadNotificationCount(store().notifications, settings())

/** lib names an actor without a profile or name by a truncated id; the DTO's fallback is `User <last 6>`. */
function actorOf(user: Notification['from'], avatars: Map<string, AuthorDTO['avatar']>): AuthorDTO {
  const placeholder = user.displayName === truncateId(user.id, 6, 4)
  const { id, username, displayName, avatar, resolved } = toUserSummaryDTO({
    id: user.id,
    username: user.username || null,
    profile: { displayName: placeholder ? undefined : user.displayName },
  })
  return { id, username, displayName, avatar: avatars.get(id) ?? avatar, resolved }
}

async function toNotificationDTOs(notifications: Notification[]): Promise<NotificationDTO[]> {
  const ids = notifications.flatMap(notification => [notification.from.id, notification.post?.author.id ?? ''])
  // Stored avatars, so a generated one is a recipe RN renders, not lib's remote DiceBear URL. Decoration: a failed read falls back.
  const avatars = await avatarsOf(ids).catch(() => new Map<string, AuthorDTO['avatar']>())
  return notifications.map(notification => {
    const isBlog = notification.type === 'blogPost' || notification.type === 'blogComment'
    const post = notification.post?.id && !isBlog ? notification.post : undefined
    return {
      id: notification.id,
      type: notification.type,
      actor: actorOf(notification.from, avatars),
      at: notification.createdAt,
      read: notification.read,
      target: post ? { id: post.id, kind: notification.targetKind ?? post.targetKind ?? 'post' } : null,
      preview: post ? toPostDTO(post, { signedIn: true, avatars }) : null,
      ...(notification.blogId && notification.blogPostSlug ? { blog: { blogId: notification.blogId, slug: notification.blogPostSlug } } : {}),
    }
  })
}

export function createNotificationsModule(emit: (event: 'notifications.count', payload: NotificationCountEvent) => void) {
  /** The account whose notifications the store holds; a first read per account loads the last 7 days. */
  let loadedFor: string | null = null
  let loading: Promise<void> | null = null

  const report = () => {
    if (viewerId()) emit('notifications.count', { unread: unreadCount() })
  }

  // Turning a type off or on changes the badge (the settled mark-visible-read rule).
  useSettingsStore.subscribe((next, previous) => {
    if (next.notificationSettings !== previous.notificationSettings && loadedFor === viewerId()) report()
  })

  /** The sidebar's first fetch (`getInitialNotifications`, 7 days) for this account. */
  function ensureLoaded(viewer: string): Promise<void> {
    if (loadedFor === viewer) return Promise.resolve()
    loading ??= (async () => {
      store().clearNotifications()
      const result = await notificationService.getInitialNotifications(viewer, store().getReadIdsSet())
      // Signed out or switched while it loaded: its result belongs to nobody now.
      if (viewerId() !== viewer) throw new RpcError('The account changed while notifications loaded', 'NOT_SIGNED_IN')
      store().setNotifications(result.notifications)
      store().setLastFetchTimestamp(result.latestTimestamp)
      store().setHasFetchedOnce(true)
      loadedFor = viewer
      report()
    })().finally(() => { loading = null })
    return loading
  }

  return {
    /**
     * One tab of the viewer's notifications, newest first, 30 a page. The
     * first call per account reads the last 7 days; later calls page what
     * is held, which `poll()` keeps current. Types turned off in settings are
     * left out.
     */
    async list(query: { filter?: NotificationFilter; cursor?: string | null } = {}): Promise<Page<NotificationDTO>> {
      const filter = query.filter ?? 'all'
      if (!FILTERS.includes(filter)) throw badRequest(`Unknown notification filter: ${String(filter)}`)
      const viewer = requireViewer('Notifications')
      const after = decodeCursor<{ after: string; at: number }>(query.cursor, `notifications:${filter}`)
      await ensureLoaded(viewer)
      const items = visible().filter(notification => inTab(notification, filter))
      let start = 0
      if (after) {
        // Keyset on (time, id): new notifications arriving at the top never shift a page.
        const index = items.findIndex(notification => notification.id === cursorString(after.after))
        start = index >= 0 ? index + 1 : items.findIndex(notification => notification.createdAt.getTime() < after.at)
        if (start < 0) start = items.length
      }
      const slice = items.slice(start, start + PAGE)
      const last = slice[slice.length - 1]
      const more = start + PAGE < items.length && last
      return nextPage(await toNotificationDTOs(slice), `notifications:${filter}`, more ? { after: last.id, at: last.createdAt.getTime() } : null)
    },

    /**
     * Fetch what arrived since the last read (`pollNewNotifications`) and
     * merge it, as the sidebar's 30 s loop does; emits `notifications.count`.
     */
    async poll(): Promise<{ added: number; unread: number }> {
      const viewer = requireViewer('Notifications')
      if (loadedFor !== viewer) {
        const before = store().notifications.length
        await ensureLoaded(viewer)
        return { added: store().notifications.length - before, unread: unreadCount() }
      }
      const result = await notificationService.pollNewNotifications(viewer, store().lastFetchTimestamp, store().getReadIdsSet())
      if (viewerId() !== viewer) return { added: 0, unread: 0 }
      const before = store().notifications.length
      if (result.notifications.length > 0) store().addNotifications(result.notifications)
      store().setLastFetchTimestamp(result.latestTimestamp)
      report()
      return { added: store().notifications.length - before, unread: unreadCount() }
    },

    /** Mark notifications read (a tap on one, `markAsRead`). */
    async markRead(ids: string[]): Promise<void> {
      requireViewer('Notifications')
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw badRequest('ids must be strings')
      for (const id of ids) store().markAsRead(id)
      report()
    },

    /** "Mark all read": only the visible, enabled types (`markAllAsRead(settings)`; the settled mark-visible-read rule). */
    async markVisibleRead(): Promise<void> {
      requireViewer('Notifications')
      store().markAllAsRead(settings())
      report()
    },

    /** The badge: unread notifications of the types turned on. */
    async unreadCount(): Promise<number> {
      const viewer = requireViewer('Notifications')
      await ensureLoaded(viewer)
      return unreadCount()
    },
  }
}
