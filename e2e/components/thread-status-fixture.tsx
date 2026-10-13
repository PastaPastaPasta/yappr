import { ThreadView, type ThreadStatus } from '@/components/messages/thread-view'
import type { InboxRow } from '@/components/messages/conversation-list'

const PEER = '5umCB4qpvLuwFW11YzYha1NuKpzJRE6ZDhRtfZbhZEbY'

const row: InboxRow = {
  key: `legacy:${PEER}`,
  kind: 'direct',
  peerId: PEER,
  name: '',
  memberIds: [],
  preview: null,
  previewOwn: false,
  lastActivity: 0,
  unread: 0,
  hidden: false,
  legacyOnly: true,
  notice: null,
}

/**
 * A thread that holds only earlier (v3/v4) messages, in the inbox's three readiness states:
 * checking whether the person can be messaged, they can't (not set up), they can.
 */
export function ThreadStatusFixture({ state }: { state: 'checking' | 'unreachable' | 'reachable' }) {
  const status: ThreadStatus = state === 'unreachable'
    ? { blockedReason: null, banner: 'Earlier messages.', unreachable: true }
    : { blockedReason: null, banner: 'Earlier messages. Your next message starts a private conversation.', composerOff: state === 'checking' }
  return (
    <ThreadView
      row={row}
      messages={[{ id: 'legacy:1', senderId: PEER, text: 'hello from before', createdAt: 1, own: false, pending: false, legacy: true }]}
      details={new Map([[PEER, { id: PEER, username: 'carol.dash', displayName: 'Carol', hasDpns: true }]])}
      status={status}
      isLoading={false}
      blocked={false}
      onBack={() => undefined}
      onSend={async () => undefined}
      onOpenGroupSettings={() => undefined}
      onToggleBlock={() => undefined}
      onHide={() => undefined}
    />
  )
}
