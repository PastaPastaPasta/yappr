/** `createChangeTracker` (ENGINE.md §8): which conversations `dm.changed` names. */
import { describe, expect, it, vi } from 'vitest'
import { createChangeTracker, type ConversationRow, type DmView } from '../../src/dm/changes'
import type { DmEvents } from '../../src/dm/types'

const row: ConversationRow = {
  key: 'd:peer',
  backend: 'v5',
  kind: 'direct',
  peerId: 'peer',
  ownerId: null,
  name: null,
  members: [],
  isOwner: false,
  lastMessage: { text: 'hi', at: new Date(1_790_000_000_000), own: true },
  lastActivity: new Date(1_790_000_000_000),
  unread: 0,
  flags: { hidden: false, unreadable: false, removed: false, ended: false, blocked: false, unsaved: false, draft: false },
  peerReadAt: null,
}

describe('dm change tracker', () => {
  it('reports a conversation whose pending messages were read back, though its row is unchanged', async () => {
    vi.useFakeTimers()
    const changed: DmEvents['dm.changed'][] = []
    const tracker = createChangeTracker({ emit: (event, payload) => { if (event === 'dm.changed') changed.push(payload as DmEvents['dm.changed']) }, coalesceMs: 0 })
    const viewWith = (pending: number): DmView => ({ rows: [row], ready: true, error: null, messages: () => [], pendingIn: () => pending })

    tracker.changed(() => viewWith(1))
    await vi.runAllTimersAsync()
    tracker.changed(() => viewWith(1))
    await vi.runAllTimersAsync()
    tracker.changed(() => viewWith(0))
    await vi.runAllTimersAsync()

    expect(changed.map(e => e.changedKeys)).toEqual([[row.key], [row.key]])
    vi.useRealTimers()
  })
})
