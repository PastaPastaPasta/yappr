'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { checkBlockedForAuthors } from '@/hooks/use-block'
import { truncateId } from '@/lib/utils'
import type { BlogComment } from '@/lib/types'
import { blogCommentService, dpnsService, unifiedProfileService } from '@/lib/services'

interface BlogCommentsProps {
  blogPostId: string
  blogPostOwnerId: string
  commentsEnabled: boolean
}

const MAX_COMMENT_LENGTH = 500

function CommentTimestamp({ createdAt }: { createdAt: Date }) {
  const relativeTime = useRelativeTime(createdAt)
  return <span>{relativeTime}</span>
}

export function BlogComments({ blogPostId, blogPostOwnerId, commentsEnabled }: BlogCommentsProps) {
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const [comments, setComments] = useState<BlogComment[]>([])
  const [usernames, setUsernames] = useState<Map<string, string | null>>(new Map())
  const [avatars, setAvatars] = useState<Map<string, string>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')

  const loadComments = useCallback(async () => {
    if (!commentsEnabled) {
      setComments([])
      setUsernames(new Map())
      setAvatars(new Map())
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const allComments = await blogCommentService.getCommentsByPost(blogPostId, { limit: 100 })
      const authorIds = Array.from(new Set(allComments.map((comment) => comment.ownerId).filter(Boolean)))

      const blockedMap = user?.identityId
        ? await checkBlockedForAuthors(user.identityId, authorIds)
        : new Map<string, boolean>()

      const filtered = allComments.filter((comment) => !blockedMap.get(comment.ownerId))
      setComments(filtered)

      const filteredAuthorIds = Array.from(new Set(filtered.map((comment) => comment.ownerId).filter(Boolean)))
      const [resolvedUsernames, resolvedAvatars] = await Promise.all([
        dpnsService.resolveUsernamesBatch(filteredAuthorIds),
        unifiedProfileService.getAvatarUrlsBatch(filteredAuthorIds),
      ])

      setUsernames(resolvedUsernames)
      setAvatars(resolvedAvatars)
    } catch {
      setError('Failed to load comments')
    } finally {
      setIsLoading(false)
    }
  }, [blogPostId, commentsEnabled, user?.identityId])

  useEffect(() => {
    loadComments().catch(() => {
      setError('Failed to load comments')
      setIsLoading(false)
    })
  }, [loadComments])

  const trimmedContent = content.trim()
  const canSubmit = trimmedContent.length > 0 && trimmedContent.length <= MAX_COMMENT_LENGTH && !isSubmitting

  const handleSubmit = async () => {
    const authedUser = requireAuth('reply')
    if (!authedUser || !canSubmit) return

    try {
      setIsSubmitting(true)
      await blogCommentService.createComment(authedUser.identityId, blogPostId, blogPostOwnerId, trimmedContent)
      setContent('')
      await loadComments()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to post comment'
      toast.error(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = async (commentId: string) => {
    if (!user?.identityId) return

    try {
      setDeletingId(commentId)
      const success = await blogCommentService.deleteComment(commentId, user.identityId)
      if (!success) {
        throw new Error('You can only delete your own comments')
      }

      setComments((prev) => prev.filter((comment) => comment.id !== commentId))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete comment'
      toast.error(message)
    } finally {
      setDeletingId(null)
    }
  }

  const headingLabel = useMemo(() => `Comments (${comments.length})`, [comments.length])

  if (!commentsEnabled) {
    return (
      <section className="rounded-xl border p-4" style={{ borderColor: 'color-mix(in srgb, var(--blog-text) 15%, transparent)' }}>
        <h3 className="text-lg font-semibold text-[var(--blog-heading)]" style={{ fontFamily: 'var(--blog-heading-font)' }}>
          Comments
        </h3>
        <p className="mt-2 text-sm text-[var(--blog-text)]/80">Comments are disabled</p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border p-4" style={{ borderColor: 'color-mix(in srgb, var(--blog-text) 15%, transparent)' }}>
      <h3 className="text-lg font-semibold text-[var(--blog-heading)]" style={{ fontFamily: 'var(--blog-heading-font)' }}>
        {headingLabel}
      </h3>

      <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'color-mix(in srgb, var(--blog-text) 15%, transparent)' }}>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write a comment..."
          maxLength={MAX_COMMENT_LENGTH}
          className="min-h-[90px] border-0 bg-transparent p-0 focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-[var(--blog-text)]/70">
            {trimmedContent.length}/{MAX_COMMENT_LENGTH}
          </p>
          <Button type="button" size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? 'Posting...' : 'Post comment'}
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading && <p className="text-sm text-[var(--blog-text)]/75">Loading comments...</p>}

        {!isLoading && error && (
          <div className="flex items-center justify-between rounded-lg border p-3" style={{ borderColor: 'color-mix(in srgb, var(--blog-text) 15%, transparent)' }}>
            <p className="text-sm text-[var(--blog-text)]/80">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => loadComments().catch(() => null)}>
              Retry
            </Button>
          </div>
        )}

        {!isLoading && !error && comments.length === 0 && (
          <p className="text-sm text-[var(--blog-text)]/75">No comments yet.</p>
        )}

        {!isLoading && !error && comments.map((comment) => {
          const resolvedUsername = usernames.get(comment.ownerId)
          const username = resolvedUsername ? resolvedUsername.replace(/\.dash$/i, '') : null
          const displayName = username ? `@${username}` : truncateId(comment.ownerId, 8, 6)
          const isOwnComment = user?.identityId === comment.ownerId

          return (
            <article
              key={comment.id}
              className="rounded-lg border p-3"
              style={{ borderColor: 'color-mix(in srgb, var(--blog-text) 15%, transparent)' }}
            >
              <div className="flex items-start gap-3">
                <UserAvatar userId={comment.ownerId} preloadedUrl={avatars.get(comment.ownerId)} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-[var(--blog-text)]/70">
                    <span className="font-medium text-[var(--blog-heading)]">{displayName}</span>
                    <span>•</span>
                    <CommentTimestamp createdAt={comment.createdAt} />
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--blog-text)]">{comment.content}</p>
                </div>
                {isOwnComment && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={deletingId === comment.id}
                    onClick={() => handleDelete(comment.id)}
                    className="h-auto px-2 py-1 text-xs"
                  >
                    {deletingId === comment.id ? 'Deleting...' : 'Delete'}
                  </Button>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
