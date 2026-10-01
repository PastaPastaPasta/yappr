import type { ConversationDTO, DmEvents, MessageDTO } from './types'

/** ENGINE.md §8: `dm.changed` at most once per 250 ms. */
const DM_CHANGED_COALESCE_MS = 250
/** Messages this much older than the session start never raise `dm.message` (clock skew against block time). */
const NOTIFY_SLACK_MS = 60_000

/** What both backends answer (internal, not a DTO): the module resolves `peerId` to `peer`. */
export type ConversationRow = Omit<ConversationDTO, 'peer'> & { peerId: string | null }

export type DmEmit = <E extends keyof DmEvents>(event: E, payload: DmEvents[E]) => void

/** What a backend reports when it changed. */
export interface DmView {
  rows: ConversationRow[]
  ready: boolean
  error: string | null
  /** The badge counts, when they are not the rows' (legacy without read receipts has none). */
  unread?: { unreadTotal: number; unreadConversations: number }
  /** The full timeline of one conversation, oldest first (asked only for changed conversations). */
  messages(key: string): MessageDTO[]
}

export function unreadCounts(rows: ConversationRow[]): { unreadTotal: number; unreadConversations: number } {
  const visible = rows.filter(row => !row.flags.hidden && row.unread > 0)
  return { unreadTotal: visible.reduce((total, row) => total + row.unread, 0), unreadConversations: visible.length }
}

/**
 * Turns backend snapshots into `dm.changed` and `dm.message` (ENGINE.md §8):
 * a conversation whose row differs from the last one reported is changed,
 * and its incoming messages not reported before are new, unless they predate
 * the session (a first load, or a recovery on a new device, is history).
 */
export function createChangeTracker(options: { emit: DmEmit; coalesceMs?: number }) {
  const coalesceMs = options.coalesceMs ?? DM_CHANGED_COALESCE_MS
  let since = Date.now()
  let reported = new Map<string, string>()
  let last: { unreadTotal: number; unreadConversations: number; ready: boolean; error: string | null } =
    { unreadTotal: 0, unreadConversations: 0, ready: false, error: null }
  const notified = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: (() => DmView | null) | null = null

  function report(view: DmView): void {
    const next = new Map(view.rows.map(row => [row.key, JSON.stringify(row)]))
    const changedKeys = [...next.keys()].filter(key => reported.get(key) !== next.get(key))
    for (const key of reported.keys()) if (!next.has(key)) changedKeys.push(key)
    reported = next
    const status = { ...(view.unread ?? unreadCounts(view.rows)), ready: view.ready, error: view.error }
    const statusChanged = status.unreadTotal !== last.unreadTotal || status.unreadConversations !== last.unreadConversations ||
      status.ready !== last.ready || status.error !== last.error
    last = status
    if (changedKeys.length > 0 || statusChanged) options.emit('dm.changed', { ...status, changedKeys })
    const cutoff = since - NOTIFY_SLACK_MS
    for (const key of changedKeys) {
      if (!next.has(key)) continue
      for (const message of view.messages(key)) {
        const id = `${key}\u0000${message.id}`
        if (message.own || message.at.getTime() < cutoff || notified.has(id)) continue
        notified.add(id)
        options.emit('dm.message', { key, message })
      }
    }
  }

  return {
    /** Report the backend's state within `coalesceMs`; `read` runs once, when the timer fires. */
    changed(read: () => DmView | null): void {
      pending = read
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const view = pending?.()
        pending = null
        if (view) report(view)
      }, coalesceMs)
    },

    /** A new session: forget what was reported, and announce that every known conversation is gone. */
    reset(): void {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
      const changedKeys = [...reported.keys()]
      reported = new Map()
      notified.clear()
      since = Date.now()
      const wasEmpty = changedKeys.length === 0 && !last.ready && last.unreadTotal === 0
      last = { unreadTotal: 0, unreadConversations: 0, ready: false, error: null }
      if (!wasEmpty) options.emit('dm.changed', { ...last, changedKeys })
    },
  }
}
