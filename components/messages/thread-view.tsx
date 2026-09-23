'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { motion } from 'framer-motion'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowLeftIcon, EllipsisHorizontalIcon, PaperAirplaneIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { UserAvatar } from '@/components/ui/avatar-image'
import { EmojiPicker } from '@/components/compose/emoji-picker'
import { isEmojiOnly } from '@/lib/utils'
import type { UserDetails } from '@/lib/utils/resolve-user-details'
import type { InboxRow } from './conversation-list'
import { MenuContent, MenuItem } from './dm-ui'
import { displayNameOf } from './use-dm-engine'

export interface ThreadMessage {
  id: string
  senderId: string
  text: string
  createdAt: number
  own: boolean
  pending: boolean
  /** Sent on the old (v3/v4) contract. */
  legacy: boolean
}

export interface ThreadStatus {
  /** Why sending is not possible, shown instead of the composer. */
  blockedReason: string | null
  /** A notice above the messages (unreadable group, removed, legacy-only). */
  banner: string | null
}

interface ThreadViewProps {
  row: InboxRow
  messages: ThreadMessage[]
  details: ReadonlyMap<string, UserDetails>
  status: ThreadStatus
  isLoading: boolean
  blocked: boolean
  onBack: () => void
  onSend: (text: string) => Promise<void>
  onOpenGroupSettings: () => void
  onToggleBlock: () => void
  onHide: () => void
}

export function ThreadView({ row, messages, details, status, isLoading, blocked, onBack, onSend, onOpenGroupSettings, onToggleBlock, onHide }: ThreadViewProps) {
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)
  const title = row.kind === 'group' ? row.name || 'Group' : displayNameOf(details, row.peerId)
  const lastId = messages.at(-1)?.id

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [lastId, row.key])

  const submit = async () => {
    const text = draft.trim()
    if (!text || isSending) return
    setIsSending(true)
    try {
      await onSend(text)
      setDraft('')
    } finally {
      setIsSending(false)
      input.current?.focus()
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <header className="flex-shrink-0 bg-white dark:bg-neutral-900 border-b border-gray-200 dark:border-gray-800 px-2 sm:px-4 py-2 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <button aria-label="Back to conversations" onClick={onBack} className="md:hidden p-1.5 -ml-1 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full flex-shrink-0">
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          {row.kind === 'group' ? (
            <button onClick={onOpenGroupSettings} className="flex items-center gap-2 sm:gap-3 hover:opacity-80 transition-opacity min-w-0 flex-1 text-left">
              <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
                <UserGroupIcon className="h-5 w-5 text-gray-500" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold truncate text-sm sm:text-base">{title}</p>
                <p className="text-xs text-gray-500 truncate">{row.memberIds.length} members</p>
              </div>
            </button>
          ) : (
            <Link href={`/user?id=${row.peerId}`} className="flex items-center gap-2 sm:gap-3 hover:opacity-80 transition-opacity min-w-0 flex-1">
              <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0">
                <UserAvatar userId={row.peerId} size="md" alt="User avatar" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold truncate text-sm sm:text-base">{title}</p>
                <p className="text-xs text-gray-500 truncate hidden sm:block">{details.get(row.peerId)?.username ?? `${row.peerId.slice(0, 12)}...`}</p>
              </div>
            </Link>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button aria-label="Conversation options" className="p-1.5 sm:p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full flex-shrink-0">
                <EllipsisHorizontalIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <MenuContent className="min-w-[200px]">
              {row.kind === 'group' ? (
                <MenuItem onClick={onOpenGroupSettings}>Group settings</MenuItem>
              ) : (
                <MenuItem onClick={onToggleBlock}>{blocked ? 'Unblock' : 'Block'} {title}</MenuItem>
              )}
              {!row.legacyOnly && (
                <MenuItem onClick={onHide} className="text-red-600">Delete conversation</MenuItem>
              )}
            </MenuContent>
          </DropdownMenu.Root>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4">
        {status.banner && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-800 dark:text-amber-300">{status.banner}</div>
        )}
        {isLoading && messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Spinner size="md" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <p>No messages yet. Start the conversation!</p>
          </div>
        ) : (
          messages.map((message, index) => {
            const showSender = row.kind === 'group' && !message.own && messages[index - 1]?.senderId !== message.senderId
            const emojiOnly = isEmojiOnly(message.text)
            return (
              <motion.div key={message.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`flex ${message.own ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[85%] sm:max-w-[75%] md:max-w-[70%]">
                  {showSender && <p className="text-xs text-gray-500 mb-1 px-2">{displayNameOf(details, message.senderId)}</p>}
                  {emojiOnly ? (
                    <p className={`text-4xl leading-tight ${message.own ? 'text-right' : 'text-left'}`}>{message.text}</p>
                  ) : (
                    <div className={`px-4 py-2 rounded-2xl ${message.own ? 'bg-yappr-500 text-white' : 'bg-gray-100 dark:bg-gray-900'} ${message.pending ? 'opacity-70' : ''}`}>
                      <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
                    </div>
                  )}
                  <p className={`text-xs text-gray-500 mt-1 px-2 ${message.own ? 'text-right' : 'text-left'}`}>
                    {formatDistanceToNow(message.createdAt, { addSuffix: true })}
                    {message.legacy && ' · earlier messaging'}
                  </p>
                </div>
              </motion.div>
            )
          })
        )}
        <div ref={bottom} />
      </div>

      <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-800 p-2 sm:p-4 safe-area-inset-bottom">
        {status.blockedReason ? (
          <p className="text-sm text-center text-gray-500 py-2">{status.blockedReason}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit().catch(() => undefined)
            }}
            className="flex items-end gap-2"
          >
            <EmojiPicker onEmojiSelect={(emoji) => setDraft((prev) => prev + emoji)} onSelectionClose={() => input.current?.focus()} disabled={isSending} />
            <Textarea
              ref={input}
              aria-label="Message"
              placeholder="Type a message..."
              value={draft}
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit().catch(() => undefined)
                }
              }}
              disabled={isSending}
              className="flex-1 min-w-0 min-h-[40px] max-h-40 resize-none text-base"
            />
            <Button type="submit" aria-label="Send message" size="sm" disabled={!draft.trim() || isSending} className="flex-shrink-0 h-9 w-9 sm:h-10 sm:w-10 p-0">
              {isSending ? <Spinner size="sm" className="border-white" /> : <PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
