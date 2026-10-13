import { useMemo } from 'react'
import { ThreadView, type ThreadStatus } from '@/components/messages/thread-view'
import type { InboxRow } from '@/components/messages/conversation-list'
import { useMessagingReadiness, type ReadinessSource } from '@/components/messages/use-messaging-readiness'

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

/** The inbox's mapping from what is known about the person to the thread's status. */
function statusFor(reachable: boolean | undefined): ThreadStatus {
  if (reachable === false) return { blockedReason: null, banner: 'Earlier messages.', unreachable: true }
  return { blockedReason: null, banner: 'Earlier messages. Your next message starts a private conversation.', composerOff: reachable === undefined }
}

/**
 * A thread that holds only earlier (v3/v4) messages, in the inbox's three readiness states:
 * checking whether the person can be messaged, they can't (not set up), they can.
 */
export function ThreadStatusFixture({ state }: { state: 'checking' | 'unreachable' | 'reachable' }) {
  return <LegacyThread status={statusFor(state === 'checking' ? undefined : state === 'reachable')} />
}

/**
 * The readiness hook driven by a scripted engine: `answers` are what successive checks return
 * (an Error rejects), the last one repeating. Exposes the number of checks as window.readinessChecks.
 */
export function LiveThreadStatusFixture({ answers }: { answers: Array<boolean | null | Error> }) {
  const source = useMemo<ReadinessSource>(() => {
    let call = 0
    return {
      async canMessage() {
        const answer = answers[Math.min(call, answers.length - 1)]
        call += 1
        window.readinessChecks = call
        if (answer instanceof Error) throw answer
        return answer
      },
    }
  }, [answers])
  const reachable = useMessagingReadiness(source, PEER, { failed: 100, notSetUp: 200 })
  return <LegacyThread status={statusFor(reachable)} />
}

function LegacyThread({ status }: { status: ThreadStatus }) {
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
