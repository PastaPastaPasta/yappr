'use client'

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { MagnifyingGlassIcon, PlusIcon, UserGroupIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { UserDetails } from '@/lib/utils/resolve-user-details'
import { MenuContent, MenuItem } from './dm-ui'
import { displayNameOf } from './use-dm-engine'

/** One row of the merged inbox: a v5 conversation, a legacy v3/v4 one, or both for the same person. */
export interface InboxRow {
  key: string
  kind: 'direct' | 'group'
  /** Peer for a 1:1; owner for a group. */
  peerId: string
  name: string
  memberIds: string[]
  preview: string | null
  previewOwn: boolean
  lastActivity: number
  unread: number
  hidden: boolean
  /** Only a legacy (v3/v4) thread exists: read-only until the first v5 message. */
  legacyOnly: boolean
  notice: string | null
}

interface ConversationListProps {
  rows: InboxRow[]
  selectedKey: string | null
  details: ReadonlyMap<string, UserDetails>
  isLoading: boolean
  showHidden: boolean
  onToggleHidden: () => void
  onSelect: (key: string) => void
  onNewMessage: (event: React.MouseEvent<HTMLElement>) => void
  onNewGroup: () => void
  onOpenSettings: () => void
  className?: string
}

function rowTitle(row: InboxRow, details: ReadonlyMap<string, UserDetails>): string {
  if (row.kind === 'group') return row.name || 'Group'
  return displayNameOf(details, row.peerId)
}

export function ConversationList({
  rows,
  selectedKey,
  details,
  isLoading,
  showHidden,
  onToggleHidden,
  onSelect,
  onNewMessage,
  onNewGroup,
  onOpenSettings,
  className,
}: ConversationListProps) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const hiddenCount = rows.filter((r) => r.hidden).length
  const visible = rows
    .filter((row) => showHidden || !row.hidden)
    .filter((row) => {
      if (!needle) return true
      const username = details.get(row.peerId)?.username ?? ''
      return rowTitle(row, details).toLowerCase().includes(needle) || username.toLowerCase().includes(needle) || row.peerId.toLowerCase().includes(needle)
    })

  return (
    <div className={className}>
      <header className="flex-shrink-0 bg-white dark:bg-neutral-900 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between px-3 sm:px-4 py-2 sm:py-3">
          <h1 className="text-lg sm:text-xl font-bold">Messages</h1>
          <div className="flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button aria-label="Message settings" onClick={onOpenSettings} className="p-1.5 sm:p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full">
                    <Cog6ToothIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Message settings</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button aria-label="New conversation" className="p-1.5 sm:p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full">
                  <PlusIcon className="h-5 w-5" aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <MenuContent className="min-w-[180px]">
                <MenuItem onClick={onNewMessage}>New message</MenuItem>
                <MenuItem onClick={onNewGroup}>New group</MenuItem>
              </MenuContent>
            </DropdownMenu.Root>
          </div>
        </div>
        <div className="px-3 sm:px-4 pb-2 sm:pb-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-500" />
            <Input type="text" placeholder="Search messages" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 sm:pl-10 h-9 sm:h-10 text-base" />
          </div>
        </div>
      </header>

      {isLoading && rows.length === 0 ? (
        <div className="p-8 text-center">
          <Spinner size="md" className="mx-auto mb-4" />
          <p className="text-gray-500">Loading conversations...</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-gray-500 text-sm">
          <p>Your conversations will appear here</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {visible.length === 0 && (
            <div className="p-8 text-center text-gray-500 text-sm">No conversations match your search</div>
          )}
          {visible.map((row) => (
            <button
              key={row.key}
              onClick={() => onSelect(row.key)}
              className={`w-full p-3 sm:p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors flex gap-3 ${selectedKey === row.key ? 'bg-gray-50 dark:bg-gray-950' : ''} ${row.hidden ? 'opacity-60' : ''}`}
            >
              <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0 flex items-center justify-center">
                {row.kind === 'group' ? (
                  <UserGroupIcon className="h-6 w-6 text-gray-500" aria-hidden="true" />
                ) : (
                  <UserAvatar userId={row.peerId} size="lg" alt="User avatar" />
                )}
              </div>
              <div className="flex-1 text-left min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="font-semibold truncate">{rowTitle(row, details)}</span>
                  {row.lastActivity > 0 && (
                    <span className="text-xs text-gray-500 flex-shrink-0">{formatDistanceToNow(row.lastActivity, { addSuffix: true })}</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate mb-1">
                  {row.kind === 'group'
                    ? `${row.memberIds.length} members`
                    : details.get(row.peerId)?.username ?? `${row.peerId.slice(0, 12)}...`}
                </p>
                {row.notice ? (
                  <p className="text-sm text-amber-600 dark:text-amber-500 truncate">{row.notice}</p>
                ) : row.preview !== null ? (
                  <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                    {row.previewOwn && 'You: '}
                    {row.preview}
                  </p>
                ) : null}
              </div>
              {row.unread > 0 && (
                <div className="flex items-center flex-shrink-0">
                  <div className="bg-yappr-500 text-white text-xs rounded-full min-w-5 h-5 px-1.5 flex items-center justify-center">{row.unread}</div>
                </div>
              )}
            </button>
          ))}
          {hiddenCount > 0 && (
            <button onClick={onToggleHidden} className="w-full p-3 text-sm text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-950">
              {showHidden ? 'Hide deleted conversations' : `Show ${hiddenCount} deleted conversation${hiddenCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
