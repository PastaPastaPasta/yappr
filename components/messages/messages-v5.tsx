'use client'

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { LockClosedIcon, PaperAirplaneIcon, PlusIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { logger } from '@/lib/logger'
import { base58ToBytes } from '@/lib/services/sdk-helpers'
import type { ConversationView } from '@/lib/services/dm-v5'
import type { Conversation } from '@/lib/types'
import { ConversationList, type InboxRow } from './conversation-list'
import { DmNotices } from './dm-notices'
import { DmSettingsDialog } from './dm-settings-dialog'
import { errorText } from './dm-ui'
import { GroupSettingsDialog, type GroupActions } from './group-settings-dialog'
import { NewGroupDialog } from './new-group-dialog'
import { NewMessageDialog } from './new-message-dialog'
import { ThreadView, type ThreadMessage, type ThreadStatus } from './thread-view'
import { useDmEngine, useEngineSnapshot, useUserDetails } from './use-dm-engine'
import { useLegacyConversations, useLegacyMessages } from './use-legacy-conversations'

const legacyKey = (peerId: string) => `legacy:${peerId}`

function notice(view: ConversationView): string | null {
  if (view.removed) return 'You are no longer in this group'
  if (view.ended) return 'This group has ended'
  if (view.unreadable) return 'Ask the owner to resend your keys'
  if (view.unsaved) return 'Not saved: conversation limit reached'
  return null
}

/**
 * Merge v5 conversations with legacy v3/v4 threads with the same person into
 * one inbox (§10). Legacy threads are frozen history: under v5 nothing is
 * written to the old contract, its read receipts included, so their unread
 * counts could never clear and are not shown.
 */
function buildRows(views: ConversationView[], legacy: Conversation[]): InboxRow[] {
  const directPeers = new Set(views.filter((v) => v.kind === 'direct').map((v) => v.peerId))
  const legacyByPeer = new Map(legacy.map((c) => [c.participantId, c]))
  const rows: InboxRow[] = views.map((view) => {
    const old = view.kind === 'direct' ? legacyByPeer.get(view.peerId) : undefined
    const oldTime = old?.lastMessage?.createdAt.getTime() ?? 0
    const newer = view.lastMessage && view.lastMessage.createdAt >= oldTime
    return {
      key: view.key,
      kind: view.kind,
      peerId: view.peerId,
      name: view.name,
      memberIds: view.memberIds,
      preview: newer ? view.lastMessage?.text ?? null : old?.lastMessage?.content ?? view.lastMessage?.text ?? null,
      previewOwn: newer ? view.lastMessage?.own ?? false : false,
      lastActivity: Math.max(view.lastActivity, oldTime),
      unread: view.unread,
      hidden: view.hidden,
      legacyOnly: false,
      notice: notice(view),
    }
  })
  for (const old of legacy) {
    if (directPeers.has(old.participantId)) continue
    rows.push({
      key: legacyKey(old.participantId),
      kind: 'direct',
      peerId: old.participantId,
      name: '',
      memberIds: [],
      preview: old.lastMessage?.content ?? null,
      previewOwn: false,
      lastActivity: old.lastMessage?.createdAt.getTime() ?? old.updatedAt.getTime(),
      unread: 0,
      hidden: false,
      legacyOnly: true,
      notice: null,
    })
  }
  return rows.sort((a, b) => b.lastActivity - a.lastActivity)
}

interface MessagesV5Props {
  identityId: string
}

/**
 * The /messages page under `NEXT_PUBLIC_DM_TOPOLOGY=v5` (docs/DM_V5.md):
 * unlinkable 1:1 and group conversations, with earlier v3/v4 threads merged
 * in read-only.
 */
export function MessagesV5({ identityId }: MessagesV5Props) {
  const searchParams = useSearchParams()
  const { engine, retry } = useDmEngine(identityId)
  const snapshot = useEngineSnapshot(engine)
  const legacy = useLegacyConversations(identityId, true)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [dialog, setDialog] = useState<'message' | 'group' | 'settings' | 'group-settings' | null>(null)
  const [pendingStart, setPendingStart] = useState<string | null>(searchParams.get('startConversation'))

  const views = useMemo(() => snapshot?.conversations ?? [], [snapshot])
  const rows = useMemo(() => buildRows(views, legacy), [views, legacy])
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null
  const selectedView = views.find((v) => v.key === selectedKey) ?? null
  const legacyThread = useMemo(() => {
    if (!selectedRow || selectedRow.kind !== 'direct') return null
    return legacy.find((c) => c.participantId === selectedRow.peerId) ?? null
  }, [legacy, selectedRow])
  const legacyMessages = useLegacyMessages(legacyThread, identityId)

  const detailIds = useMemo(
    () => [...rows.flatMap((r) => [r.peerId, ...r.memberIds]), ...(snapshot?.blocked ?? [])],
    [rows, snapshot?.blocked]
  )
  const details = useUserDetails(detailIds)

  // Tell the engine which thread is on screen (fast polling, own streams, history).
  useEffect(() => {
    if (!engine) return
    const key = selectedKey && !selectedKey.startsWith('legacy:') ? selectedKey : null
    engine.openConversation(key).catch((error) => logger.warn('Could not open conversation:', error))
    // Leaving the page (or the thread) drops back to the 30-second background poll.
    return () => {
      engine.openConversation(null).catch((error) => logger.warn('Could not close conversation:', error))
    }
  }, [engine, selectedKey])

  // Reading a thread moves its read position (coalesced into the next self-state save).
  const unreadInSelected = selectedView?.unread ?? 0
  useEffect(() => {
    if (engine && selectedKey && unreadInSelected > 0 && !selectedKey.startsWith('legacy:')) engine.markRead(selectedKey)
  }, [engine, selectedKey, unreadInSelected])

  const startDirect = useCallback(
    async (peerId: string) => {
      if (!engine) throw new Error('Messages are still loading')
      const key = await engine.startDirect(peerId)
      setSelectedKey(key)
    },
    [engine]
  )

  // ?startConversation=<identity id> from profile pages.
  useEffect(() => {
    if (!pendingStart || !engine || !snapshot?.ready) return
    setPendingStart(null)
    const bytes = base58ToBytes(pendingStart)
    if (!bytes || bytes.length !== 32) {
      toast.error('Invalid user ID')
      return
    }
    if (pendingStart === identityId) {
      toast.error("You can't message yourself")
      return
    }
    startDirect(pendingStart).catch((error) => toast.error(errorText(error, 'Failed to start conversation')))
  }, [pendingStart, engine, snapshot?.ready, identityId, startDirect])

  const openNewMessage = (event?: MouseEvent<HTMLElement>) => {
    event?.preventDefault()
    setDialog('message')
  }

  if (!engine) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <LockClosedIcon className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Unlock your messages</h2>
          <p className="text-gray-500 mb-6">Messages are encrypted with your encryption key. Enter it on this device to read and send them.</p>
          <Button onClick={() => useEncryptionKeyModal.getState().open('read_messages', retry)}>Enter encryption key</Button>
        </div>
      </div>
    )
  }

  const sendTo = async (row: InboxRow, text: string) => {
    try {
      const key = row.legacyOnly ? await engine.startDirect(row.peerId) : row.key
      await engine.send(key, text)
      if (row.legacyOnly) setSelectedKey(key)
    } catch (error) {
      toast.error(errorText(error, 'Failed to send message'))
      throw error
    }
  }

  const threadMessages: ThreadMessage[] = [
    ...legacyMessages.map((m) => ({
      id: `legacy:${m.id}`,
      senderId: m.senderId,
      text: m.content,
      createdAt: m.createdAt.getTime(),
      own: m.senderId === identityId,
      pending: false,
      legacy: true,
    })),
    ...(selectedRow && !selectedRow.legacyOnly ? engine.messages(selectedRow.key) : []).map((m) => ({ ...m, legacy: false })),
  ].sort((a, b) => a.createdAt - b.createdAt)

  const blockedIds = new Set(snapshot?.blocked ?? [])
  const threadStatus = (row: InboxRow): ThreadStatus => {
    if (row.kind === 'direct' && blockedIds.has(row.peerId)) return { blockedReason: 'You blocked this person. Unblock them to send messages.', banner: null }
    if (!selectedView) return { blockedReason: null, banner: row.legacyOnly ? 'Earlier messages. Your next message starts a private conversation.' : null }
    if (selectedView.removed) return { blockedReason: 'You are no longer a member of this group.', banner: null }
    if (selectedView.ended) return { blockedReason: 'This group has ended.', banner: null }
    if (selectedView.unreadable) return { blockedReason: 'You cannot read this group yet.', banner: 'Ask the owner to resend your keys: they can do it from the group settings.' }
    return { blockedReason: null, banner: null }
  }

  const groupActions = (key: string): GroupActions => ({
    rename: (name) => engine.renameGroup(key, name),
    add: (id) => engine.addMember(key, id),
    remove: (id) => engine.removeMember(key, id),
    resendKeys: (id) => engine.resendKeys(key, id),
    leave: async () => {
      await engine.leaveGroup(key)
      setDialog(null)
      setSelectedKey(null)
    },
    end: () => engine.endGroup(key),
  })

  const hideSelected = () => {
    if (!selectedRow || selectedRow.legacyOnly) return
    engine.hide(selectedRow.key)
    setSelectedKey(null)
    toast.success('Conversation deleted. It comes back if a new message arrives.')
  }

  const isLoading = !snapshot?.ready

  return (
    <>
      <div className={`w-full md:w-[320px] lg:w-[380px] xl:w-[400px] border-r border-gray-200 dark:border-gray-800 flex flex-col flex-shrink-0 overflow-hidden ${selectedRow ? 'hidden md:flex' : 'flex'}`}>
        <DmNotices
          recovery={snapshot?.recovery ?? null}
          capReached={snapshot?.capReached ?? false}
          showMigration={legacy.length > 0 && snapshot?.migrationNoticeSeen === false}
          onDismissMigration={() => engine.dismissMigrationNotice()}
          error={snapshot?.error ?? null}
        />
        <ConversationList
          className="flex flex-col flex-1 overflow-hidden"
          rows={rows}
          selectedKey={selectedKey}
          details={details}
          isLoading={isLoading}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden((v) => !v)}
          onSelect={setSelectedKey}
          onNewMessage={openNewMessage}
          onNewGroup={() => setDialog('group')}
          onOpenSettings={() => setDialog('settings')}
        />
      </div>

      {selectedRow ? (
        <ThreadView
          key={selectedRow.key}
          row={selectedRow}
          messages={threadMessages}
          details={details}
          status={threadStatus(selectedRow)}
          isLoading={isLoading}
          blocked={blockedIds.has(selectedRow.peerId)}
          onBack={() => setSelectedKey(null)}
          onSend={(text) => sendTo(selectedRow, text)}
          onOpenGroupSettings={() => setDialog('group-settings')}
          onToggleBlock={() => engine.setBlocked(selectedRow.peerId, !blockedIds.has(selectedRow.peerId))}
          onHide={hideSelected}
        />
      ) : (
        <div className={`${rows.length === 0 ? 'flex' : 'hidden md:flex'} flex-1 items-center justify-center p-8`}>
          <div className="text-center max-w-sm">
            {isLoading ? (
              <Spinner size="md" className="mx-auto" />
            ) : (
              <>
                <PaperAirplaneIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-2xl font-semibold mb-2">{rows.length === 0 ? 'Welcome to Messages' : 'Select a conversation'}</h2>
                <p className="text-gray-500 mb-2">Private 1-on-1 and group conversations.</p>
                <p className="text-gray-400 text-sm mb-6">Messages are encrypted, and nobody watching Dash Platform can tell who you talk to.</p>
                <div className="flex gap-2 justify-center">
                  <Button onClick={openNewMessage} className="gap-2">
                    <PlusIcon className="h-5 w-5" />
                    New message
                  </Button>
                  <Button variant="outline" onClick={() => setDialog('group')}>New group</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <NewMessageDialog open={dialog === 'message'} onOpenChange={(open) => setDialog(open ? 'message' : null)} viewerId={identityId} onStart={(user) => startDirect(user.id)} />
      <NewGroupDialog
        open={dialog === 'group'}
        onOpenChange={(open) => setDialog(open ? 'group' : null)}
        viewerId={identityId}
        onCreate={async (name, memberIds) => {
          const { key, failed } = await engine.createGroup(name, memberIds)
          setSelectedKey(key)
          if (failed.length > 0) toast.error(`${failed.length} member(s) did not get the group key yet. Use "Resend keys" in the group settings.`)
        }}
      />
      <DmSettingsDialog
        open={dialog === 'settings'}
        onOpenChange={(open) => setDialog(open ? 'settings' : null)}
        retention={snapshot?.retention ?? '30d'}
        onRetention={(retention) => engine.setRetention(retention)}
        blocked={snapshot?.blocked ?? []}
        details={details}
        onUnblock={(id) => engine.setBlocked(id, false)}
      />
      {selectedView?.kind === 'group' && (
        <GroupSettingsDialog
          key={selectedView.key}
          open={dialog === 'group-settings'}
          onOpenChange={(open) => setDialog(open ? 'group-settings' : null)}
          group={selectedView}
          viewerId={identityId}
          details={details}
          actions={groupActions(selectedView.key)}
        />
      )}
    </>
  )
}
