'use client'

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  BookmarkIcon,
  ChatBubbleOvalLeftIcon,
  CurrencyDollarIcon,
  HeartIcon,
  PencilSquareIcon,
} from '@heroicons/react/24/outline'
import { HeartIcon as HeartIconSolid, BookmarkIcon as BookmarkIconSolid } from '@heroicons/react/24/solid'
import { formatNumber } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { logger } from '@/lib/logger'

function ActionTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded" sideOffset={5}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

const MENU_ITEM = 'flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer outline-none'

interface PostActionBarProps {
  postId: string
  isOwnPost: boolean
  reply: { count: number; enabled: boolean; reason?: string | null; onClick: () => void }
  repost: { count: number; active: boolean; loading: boolean; allowed: boolean; onClick: () => void }
  quote: { onClick: () => void }
  like: { count: number; active: boolean; loading: boolean; onClick: () => void }
  tip: { onClick: () => void }
  /** Absent where the topology has no bookmark doctype for this kind. */
  bookmark?: { active: boolean; loading: boolean; onClick: () => void }
  share: { onClick: () => void }
}

const stop = (e: React.MouseEvent) => e.stopPropagation()
const run = (e: React.MouseEvent, action: () => void | Promise<void>) => {
  e.stopPropagation()
  Promise.resolve(action()).catch((error) => logger.error(error))
}

/** The reply / repost / like / tip / bookmark / share row under a post. */
export function PostActionBar({ postId, isOwnPost, reply, repost, quote, like, tip, bookmark, share }: PostActionBarProps) {
  return (
    <div className="flex items-center justify-between mt-1 -ml-2 max-w-[485px]">
      <Tooltip.Provider>
        <ActionTooltip label={reply.reason || 'Reply'}>
          <button
            data-testid={`reply-btn-${postId}`}
            onClick={(e) => run(e, reply.onClick)}
            disabled={!reply.enabled}
            className={cn('group flex items-center gap-1 p-2 rounded-full transition-colors', reply.enabled ? 'hover:bg-yappr-50 dark:hover:bg-yappr-950' : 'opacity-50 cursor-not-allowed')}
          >
            <ChatBubbleOvalLeftIcon className={cn('h-5 w-5 transition-colors', reply.enabled ? 'text-gray-500 group-hover:text-yappr-500' : 'text-gray-400')} />
            <span className={cn('text-sm transition-colors', reply.enabled ? 'text-gray-500 group-hover:text-yappr-500' : 'text-gray-400')}>
              {reply.count > 0 && formatNumber(reply.count)}
            </span>
          </button>
        </ActionTooltip>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              data-testid={`repost-menu-btn-${postId}`}
              onClick={stop}
              disabled={repost.loading}
              className={cn(
                'group flex items-center gap-1 p-2 rounded-full transition-colors hover:bg-green-50 dark:hover:bg-green-950',
                repost.loading && 'opacity-50 cursor-wait',
                repost.active && 'text-green-500'
              )}
            >
              <ArrowPathIcon className={cn('h-5 w-5 transition-colors', repost.loading && 'animate-spin', repost.active ? 'text-green-500' : 'text-gray-500 group-hover:text-green-500')} />
              <span className={cn('text-sm transition-colors', repost.active ? 'text-green-500' : 'text-gray-500 group-hover:text-green-500')}>
                {repost.count > 0 && formatNumber(repost.count)}
              </span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="min-w-[160px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
              sideOffset={5}
              onClick={stop}
            >
              {/* Reposting a reply has no doctype on v3, so the item is absent rather than failing. */}
              {repost.allowed && (
                <DropdownMenu.Item onClick={(e) => run(e, repost.onClick)} className={MENU_ITEM}>
                  <ArrowPathIcon className={cn('h-5 w-5', repost.active && 'text-green-500')} />
                  {repost.active ? 'Undo Repost' : 'Repost'}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item onClick={(e) => run(e, quote.onClick)} className={MENU_ITEM}>
                <PencilSquareIcon className="h-5 w-5" />
                Quote
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <ActionTooltip label="Like">
          <button
            data-testid={`like-btn-${postId}`}
            aria-pressed={like.active}
            onClick={(e) => run(e, like.onClick)}
            disabled={like.loading}
            className={cn(
              'group flex items-center gap-1 p-2 rounded-full transition-colors hover:bg-red-50 dark:hover:bg-red-950',
              like.loading && 'opacity-50 cursor-wait',
              like.active && 'text-red-500'
            )}
          >
            <motion.div whileTap={{ scale: 0.8 }} transition={{ type: 'spring', stiffness: 400, damping: 17 }}>
              {like.active ? <HeartIconSolid className="h-5 w-5 text-red-500" /> : <HeartIcon className="h-5 w-5 text-gray-500 group-hover:text-red-500 transition-colors" />}
            </motion.div>
            <span className={cn('text-sm transition-colors', like.active ? 'text-red-500' : 'text-gray-500 group-hover:text-red-500')}>
              {like.count > 0 && formatNumber(like.count)}
            </span>
          </button>
        </ActionTooltip>

        <ActionTooltip label={isOwnPost ? "Can't tip yourself" : 'Tip'}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (!isOwnPost) tip.onClick()
            }}
            disabled={isOwnPost}
            className={cn('group flex items-center gap-1 p-2 rounded-full transition-colors', isOwnPost ? 'opacity-40 cursor-not-allowed' : 'hover:bg-amber-50 dark:hover:bg-amber-950')}
          >
            <CurrencyDollarIcon className={cn('h-5 w-5 transition-colors', isOwnPost ? 'text-gray-400' : 'text-gray-500 group-hover:text-amber-500')} />
          </button>
        </ActionTooltip>

        <div className="flex items-center gap-1">
          {bookmark && (
            <ActionTooltip label="Bookmark">
              <button
                data-testid={`bookmark-btn-${postId}`}
                onClick={(e) => run(e, bookmark.onClick)}
                disabled={bookmark.loading}
                className={cn('p-2 rounded-full hover:bg-yappr-50 dark:hover:bg-yappr-950 transition-colors', bookmark.loading && 'opacity-50 cursor-wait')}
              >
                {bookmark.active ? <BookmarkIconSolid className="h-5 w-5 text-yappr-500" /> : <BookmarkIcon className="h-5 w-5 text-gray-500 hover:text-yappr-500 transition-colors" />}
              </button>
            </ActionTooltip>
          )}
          <ActionTooltip label="Share">
            <button onClick={(e) => run(e, share.onClick)} className="p-2 rounded-full hover:bg-yappr-50 dark:hover:bg-yappr-950 transition-colors">
              <ArrowUpTrayIcon className="h-5 w-5 text-gray-500 hover:text-yappr-500 transition-colors" />
            </button>
          </ActionTooltip>
        </div>
      </Tooltip.Provider>
    </div>
  )
}
