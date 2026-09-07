'use client'

import { useRouter } from 'next/navigation'
import { AtSymbolIcon } from '@heroicons/react/24/outline'
import type { Post } from '@/lib/types'
import { cn } from '@/lib/utils'
import { likesAreIndexOnly } from '@/lib/contract-topology'
import { filterHiddenSensitive } from '@/lib/sensitive-content'
import { useSettingsStore } from '@/lib/store'
import type { RankingWindow } from '@/lib/services/ranked-likes'
import { Spinner } from '@/components/ui/spinner'
import { PostCard } from '@/components/post/post-card'
import { RankingWindowToggle } from '@/components/explore/ranking-window-toggle'
import { InfiniteScrollSentinel } from '@/components/ui/infinite-scroll-sentinel'

export type ProfileTab = 'posts' | 'replies' | 'top' | 'mentions' | 'blog'

export interface ProfileBlog {
  id: string
  name: string
  description?: string
  postCount: number
}

interface PostListState {
  posts: Post[]
  loading: boolean
}

interface ProfileTabsProps {
  activeTab: ProfileTab
  onTabChange: (tab: ProfileTab) => void
  viewerId?: string
  getPostEnrichment: (post: Post) => React.ComponentProps<typeof PostCard>['enrichment']
  posts: Post[]
  replies: PostListState & { parents: Map<string, Post>; parentsLoading: boolean }
  top: PostListState & { window: RankingWindow; onWindowChange: (w: RankingWindow) => void }
  mentions: PostListState
  blogs: { blogs: ProfileBlog[]; loading: boolean }
  pagination: {
    hasMore: boolean
    isLoading: boolean
    isSuspended: boolean
    sentinelRef: React.ComponentProps<typeof InfiniteScrollSentinel>['sentinelRef']
    onLoadMore: () => void
  }
}

const EMPTY_COPY: Record<'posts' | 'replies' | 'top', string> = {
  posts: 'No original posts yet',
  replies: 'No replies yet',
  top: 'No liked posts yet',
}

function Loading({ text }: { text: string }) {
  return (
    <div className="p-8 text-center">
      <Spinner size="md" className="mx-auto mb-4" />
      <p className="text-gray-500">{text}</p>
    </div>
  )
}

/** The tab strip under a profile card and whichever list it selects. */
export function ProfileTabs({ activeTab, onTabChange, viewerId, getPostEnrichment, posts, replies, top, mentions, blogs, pagination }: ProfileTabsProps) {
  const router = useRouter()
  const sensitiveContentMode = useSettingsStore((s) => s.sensitiveContentMode)

  const tabs: { key: ProfileTab; label: string; testId?: string }[] = [
    { key: 'posts', label: 'Posts' },
    { key: 'replies', label: 'Replies' },
    // Server-ranked top posts need the v4 ranked like axes.
    ...(likesAreIndexOnly() ? [{ key: 'top' as const, label: 'Top', testId: 'profile-top-filter' }] : []),
    { key: 'mentions', label: 'Mentions' },
    ...(blogs.blogs.length > 0 ? [{ key: 'blog' as const, label: 'Blog' }] : []),
  ]

  const renderPostList = () => {
    const tab = activeTab as 'posts' | 'replies' | 'top'
    const list = tab === 'top' ? top.posts : tab === 'replies' ? replies.posts : posts
    if ((tab === 'replies' && replies.loading) || (tab === 'top' && top.loading)) {
      return <Loading text={tab === 'top' ? 'Loading top posts...' : 'Loading replies...'} />
    }
    if (list.length === 0) {
      return (
        <div className="p-8 text-center text-gray-500" data-testid={tab === 'top' ? 'profile-top-empty' : undefined}>
          <p>{EMPTY_COPY[tab]}</p>
        </div>
      )
    }
    return (
      <div>
        {filterHiddenSensitive(list, sensitiveContentMode, viewerId).map((post) => (
          <PostCard
            key={post.id}
            post={post}
            enrichment={getPostEnrichment(post)}
            parentPost={tab === 'replies' ? replies.parents.get(post.id) : undefined}
            parentPostLoading={tab === 'replies' && replies.parentsLoading}
          />
        ))}
        {/* Only the Posts tab paginates. */}
        {tab === 'posts' && pagination.hasMore && (
          <InfiniteScrollSentinel
            sentinelRef={pagination.sentinelRef}
            isLoading={pagination.isLoading}
            isSuspended={pagination.isSuspended}
            onLoadMore={pagination.onLoadMore}
            label="Load more posts"
            className="border-t border-gray-200 dark:border-gray-800"
          />
        )}
      </div>
    )
  }

  const renderMentions = () => {
    if (mentions.loading) return <Loading text="Loading mentions..." />
    if (mentions.posts.length === 0) {
      return (
        <div className="p-8 text-center text-gray-500">
          <AtSymbolIcon className="h-12 w-12 mx-auto mb-4 text-gray-300" />
          <p>No mentions yet</p>
          <p className="text-sm mt-2">Posts that mention this user will appear here</p>
        </div>
      )
    }
    return (
      <div>
        {filterHiddenSensitive(mentions.posts, sensitiveContentMode, viewerId).map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>
    )
  }

  const renderBlogs = () => {
    if (blogs.loading) return <Loading text="Loading blogs..." />
    if (blogs.blogs.length === 0) {
      return (
        <div className="p-8 text-center text-gray-500">
          <p>No blogs yet</p>
        </div>
      )
    }
    return (
      <div className="p-4 space-y-3">
        {blogs.blogs.map((blog) => (
          <button
            key={blog.id}
            onClick={() => router.push(`/blog?blog=${encodeURIComponent(blog.id)}`)}
            className="w-full rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-950 p-4 text-left hover:border-gray-300 dark:hover:border-gray-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <p className="text-lg font-semibold">{blog.name}</p>
            {blog.description && <p className="mt-1 text-sm text-gray-500">{blog.description}</p>}
            <p className="mt-2 text-xs text-gray-500">{blog.postCount} posts</p>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-800">
      <div className="flex border-b border-gray-200 dark:border-gray-800">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            data-testid={tab.testId}
            className="flex-1 flex justify-center transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-900/50"
          >
            <span className={cn('relative py-4 text-[15px]', activeTab === tab.key ? 'font-bold text-gray-900 dark:text-white' : 'font-medium text-gray-500')}>
              {tab.label}
              {activeTab === tab.key && <span className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-yappr-500" />}
            </span>
          </button>
        ))}
      </div>

      {activeTab === 'top' && <RankingWindowToggle value={top.window} onChange={top.onWindowChange} testIdPrefix="profile-top" />}
      {activeTab === 'mentions' ? renderMentions() : activeTab === 'blog' ? renderBlogs() : renderPostList()}
    </div>
  )
}
