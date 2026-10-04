import { getVisibleUnreadNotificationCount, isNotificationEnabled } from '@/lib/notification-preferences'
import { blockService } from '@/lib/services/block-service'
import { notificationService } from '@/lib/services/notification-service'
import { useSettingsStore } from '@/lib/store'
import { useNotificationStore } from '@/lib/stores/notification-store'
import type { Notification } from '@/lib/types'
import { truncateId } from '@/lib/utils/common'
import { RpcError } from '../protocol/envelope'
import { readJson } from '../read-json'
import { cursorString, decodeCursor } from '../dto/cursor'
import { avatarsOf, badRequest, readFailure, requireViewer, viewerId } from '../dto/hydrate'
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
   * For a reply, `kind` is what it answered ("replied to your reply"), as
   * far as the topology tells; the reply itself is always a reply.
   */
  target: { id: string; kind: 'post' | 'reply' } | null
  preview: PostDTO | null
  /** Blog events (shown under All with "View on web"; blogs are not in 1.0). */
  blog?: { blogId: string; slug: string }
  /** v11 aggregated like (NOTIF-06): how many identities it stands for, when more than one; `actor` is the first. */
  likers?: number
  /** v11 like: `at` is when this device first noticed it, not an on-chain time ("Noticed 2h ago"). */
  noticed?: true
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

/**
 * The list, tab counts and badge share one visibility rule: notifications
 * from blocked actors (NOTIF-08) and types turned off in settings are hidden.
 */
const unblocked = (blocked: ReadonlySet<string>) => store().notifications.filter(notification => !blocked.has(notification.from.id))
const visible = (blocked: ReadonlySet<string>) => unblocked(blocked).filter(notification => isNotificationEnabled(notification, settings()))
const unreadCountOf = (blocked: ReadonlySet<string>) => getVisibleUnreadNotificationCount(unblocked(blocked), settings())

/**
 * The actors among these notifications the viewer blocks, by their own
 * block or a followed list (`checkBlockedBatch`, which a local block or
 * unblock updates). `null` when that can't be read: the caller keeps what
 * it knew, as feeds fail soft to "not blocked".
 */
async function blockedAmong(viewer: string, notifications: Notification[]): Promise<Set<string> | null> {
  const actors = Array.from(new Set(notifications.map(notification => notification.from.id)))
  if (actors.length === 0) return new Set()
  const result = await blockService.checkBlockedBatch(viewer, actors).catch(() => null)
  return result ? new Set(actors.filter(actor => result.get(actor) === true)) : null
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(id => b.has(id))

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

/**
 * "Your post" or "your reply": lib's `targetKind` where the topology can tell
 * (as web's `notificationMessage`). Otherwise the post's own kind, except for
 * a reply notification, whose post is the new reply, not what it answered.
 */
function targetKindOf(notification: Notification, post: NonNullable<Notification['post']>): 'post' | 'reply' {
  if (notification.targetKind) return notification.targetKind
  return notification.type === 'reply' ? 'post' : post.targetKind ?? 'post'
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
      target: post ? { id: post.id, kind: targetKindOf(notification, post) } : null,
      preview: post ? toPostDTO(post, { signedIn: true, avatars }) : null,
      ...(notification.blogId && notification.blogPostSlug ? { blog: { blogId: notification.blogId, slug: notification.blogPostSlug } } : {}),
      ...(notification.likerCount !== undefined && notification.likerCount > 1 ? { likers: notification.likerCount } : {}),
      ...(notification.timeless ? { noticed: true as const } : {}),
    }
  })
}

export function createNotificationsModule(emit: (event: 'notifications.count', payload: NotificationCountEvent) => void) {
  /** The account whose notifications the store holds; a first read per account loads the last 7 days. */
  let loadedFor: string | null = null
  let loading: { viewer: string; token: object; done: Promise<void> } | null = null
  /** The blocked actors among the notifications held for `loadedFor`. */
  let blocked: ReadonlySet<string> = new Set()
  const unreadCount = () => unreadCountOf(blocked)

  const report = () => {
    if (viewerId()) emit('notifications.count', { unread: unreadCount() })
  }

  // Turning a type off or on changes the badge (the settled mark-visible-read rule).
  useSettingsStore.subscribe((next, previous) => {
    if (next.notificationSettings !== previous.notificationSettings && loadedFor === viewerId()) report()
  })

  /**
   * The read state persisted for the account now signed in. Sign-out removes
   * the stored copy but not zustand's in-memory one, so without this a
   * sign-in on the same engine would carry the last account's read ids.
   */
  function restoreReadState(): void {
    const stored = readJson<{ state?: { readIds?: unknown; lastFetchTimestamp?: unknown } }>(
      localStorage, useNotificationStore.persist.getOptions().name ?? '', {})
    const readIds = Array.isArray(stored.state?.readIds) ? stored.state.readIds.filter((id): id is string => typeof id === 'string') : []
    const lastFetchTimestamp = typeof stored.state?.lastFetchTimestamp === 'number' ? stored.state.lastFetchTimestamp : 0
    useNotificationStore.setState({ readIds, lastFetchTimestamp })
  }

  /** The sidebar's first fetch (`getInitialNotifications`, 7 days) for this account. */
  function ensureLoaded(viewer: string): Promise<void> {
    if (loadedFor === viewer) return Promise.resolve()
    if (loading?.viewer === viewer) return loading.done
    loadedFor = null
    const token = {}
    const done = (async () => {
      // Before anything persists the store again, which would write the old account's read ids back.
      restoreReadState()
      store().clearNotifications()
      // Signed out, switched, or overtaken by another account's load: its result belongs to nobody now.
      const overtaken = () => viewerId() !== viewer || loading?.token !== token
      const changed = () => new RpcError('The account changed while notifications loaded', 'NOT_SIGNED_IN')
      const result = await notificationService.getInitialNotifications(viewer, store().getReadIdsSet())
      // Before the failure below: a departed account's load is NOT_SIGNED_IN, never an error to show.
      if (overtaken()) throw changed()
      // lib answers a failed source with no notifications. With nothing at all, "none" is a guess, and
      // it would stick: polls only read what is newer. Fail instead, so the list shows the G-11 error
      // and a retry reads the 7 days again (NEW-R-vi-002). Partial results show; the next poll reads
      // the failed source's window again (lib keeps the watermark).
      if (result.failure !== undefined && result.notifications.length === 0) throw readFailure(result.failure)
      const blockedNow = await blockedAmong(viewer, result.notifications)
      if (overtaken()) throw changed()
      store().setNotifications(result.notifications)
      store().setLastFetchTimestamp(result.latestTimestamp)
      store().setHasFetchedOnce(true)
      blocked = blockedNow ?? new Set()
      loadedFor = viewer
      report()
    })().finally(() => {
      if (loading?.token === token) loading = null
    })
    loading = { viewer, token, done }
    return done
  }

  /**
   * Re-reads which held actors are blocked, so a block or unblock (here or
   * on another device) reaches the list and the badge. True when it changed.
   */
  async function refreshBlocked(viewer: string): Promise<boolean> {
    const next = await blockedAmong(viewer, store().notifications)
    if (!next || loadedFor !== viewer || viewerId() !== viewer || sameSet(next, blocked)) return false
    blocked = next
    return true
  }

  return {
    /** After a sign-in, sign-out or switch, the next read loads the account signed in now. */
    sessionChanged({ reason }: { reason: string }): void {
      if (reason !== 'balance') loadedFor = null
    },

    api: {
    /**
     * One tab of the viewer's notifications, newest first, 30 a page. The
     * first call per account reads the last 7 days; later calls page what
     * is held, which `poll()` keeps current. Types turned off in settings are
     * left out, as are those from actors the viewer blocks.
     */
    async list(query: { filter?: NotificationFilter; cursor?: string | null } = {}): Promise<Page<NotificationDTO>> {
      const filter = query.filter ?? 'all'
      if (!FILTERS.includes(filter)) throw badRequest(`Unknown notification filter: ${String(filter)}`)
      const viewer = requireViewer('Notifications')
      const after = decodeCursor<{ after: string; at: number }>(query.cursor, `notifications:${filter}`)
      await ensureLoaded(viewer)
      if (!after && await refreshBlocked(viewer)) report()
      const items = visible(blocked).filter(notification => inTab(notification, filter))
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
     * `blockedChanged`: a block or unblock changed which held ones are shown.
     */
    async poll(): Promise<{ added: number; unread: number; blockedChanged: boolean }> {
      const viewer = requireViewer('Notifications')
      if (loadedFor !== viewer) {
        const before = store().notifications.length
        await ensureLoaded(viewer)
        return { added: store().notifications.length - before, unread: unreadCount(), blockedChanged: false }
      }
      const result = await notificationService.pollNewNotifications(viewer, store().lastFetchTimestamp, store().getReadIdsSet())
      if (viewerId() !== viewer) return { added: 0, unread: 0, blockedChanged: false }
      const before = store().notifications.length
      if (result.notifications.length > 0) store().addNotifications(result.notifications)
      store().setLastFetchTimestamp(result.latestTimestamp)
      const added = store().notifications.length - before
      // A block or unblock since the last poll changes the list and the badge too.
      const blockedChanged = await refreshBlocked(viewer)
      if (viewerId() !== viewer) return { added: 0, unread: 0, blockedChanged: false }
      report()
      return { added, unread: unreadCount(), blockedChanged }
    },

    /** Mark notifications read (a tap on one, `markAsRead`). */
    async markRead(ids: string[]): Promise<void> {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw badRequest('ids must be strings')
      // Marks land in this account's read state, never in the one the store held before.
      await ensureLoaded(requireViewer('Notifications'))
      for (const id of ids) store().markAsRead(id)
      report()
    },

    /** "Mark all read": only the visible, enabled types (`markAllAsRead(settings)`; the settled mark-visible-read rule). */
    async markVisibleRead(): Promise<void> {
      await ensureLoaded(requireViewer('Notifications'))
      store().markAllAsRead(settings())
      report()
    },

    /** The badge: unread notifications of the types turned on. */
    async unreadCount(): Promise<number> {
      const viewer = requireViewer('Notifications')
      await ensureLoaded(viewer)
      return unreadCount()
    },
    },
  }
}
