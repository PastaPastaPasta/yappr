'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  XMarkIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline'
import { useAppStore, ThreadPost } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { UserAvatar } from '@/components/ui/avatar-image'
import { extractAllTags } from '@/lib/post-helpers'
import { hashtagService } from '@/lib/services/hashtag-service'
import { formatTime } from '@/lib/utils'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials } from '@/lib/utils'
import { MarkdownContent } from '@/components/ui/markdown-content'

const CHARACTER_LIMIT = 500

// Formatting button component
function FormatButton({
  onClick,
  title,
  children,
  disabled = false,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  )
}

// Character counter component with ready-to-post indicator
function CharacterCounter({ current, limit }: { current: number; limit: number }) {
  const remaining = limit - current
  const percentage = Math.min((current / limit) * 100, 100)
  const isWarning = remaining <= 50 && remaining > 20
  const isDanger = remaining <= 20
  const isValid = current > 0 && current <= limit

  // Calculate circle properties
  const radius = 10
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - percentage / 100)

  return (
    <div className="flex items-center gap-2">
      {current > 0 && (
        <>
          <div className="relative w-6 h-6">
            <svg className="w-6 h-6 -rotate-90" viewBox="0 0 24 24">
              {/* Background circle */}
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-gray-200 dark:text-gray-700"
              />
              {/* Progress circle */}
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className={
                  isDanger
                    ? 'text-red-500'
                    : isWarning
                    ? 'text-amber-500'
                    : 'text-yappr-500'
                }
              />
            </svg>
            {/* Checkmark when valid and not in danger zone */}
            {isValid && !isDanger && !isWarning && (
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-3 h-3 text-yappr-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
          </div>
          {isDanger && (
            <span
              className={`text-xs font-medium tabular-nums ${
                remaining < 0 ? 'text-red-500' : 'text-amber-500'
              }`}
            >
              {remaining}
            </span>
          )}
        </>
      )}
    </div>
  )
}

// Thread post editor component
function ThreadPostEditor({
  post,
  index,
  isActive,
  isOnly,
  showPreview,
  onActivate,
  onRemove,
  onContentChange,
  textareaRef,
}: {
  post: ThreadPost
  index: number
  isActive: boolean
  isOnly: boolean
  showPreview: boolean
  onActivate: () => void
  onRemove: () => void
  onContentChange: (content: string) => void
  textareaRef?: React.RefObject<HTMLTextAreaElement>
}) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const ref = textareaRef || localRef

  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.focus()
    }
  }, [isActive, ref])

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const textarea = ref.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.max(80, textarea.scrollHeight)}px`
    }
  }, [ref])

  useEffect(() => {
    adjustHeight()
  }, [post.content, adjustHeight])

  const handleInsertFormat = (prefix: string, suffix: string = prefix) => {
    const textarea = ref.current
    if (!textarea) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const content = post.content
    const selectedText = content.substring(start, end)

    // Check if we should toggle OFF the formatting
    let shouldRemove = false
    let removeStart = start
    let removeEnd = end

    if (selectedText) {
      // Case 1: Selected text is already wrapped with the formatting
      if (selectedText.startsWith(prefix) && selectedText.endsWith(suffix)) {
        shouldRemove = true
        removeStart = start
        removeEnd = end
      }
      // Case 2: Selection is inside formatted text
      else if (
        start >= prefix.length &&
        content.substring(start - prefix.length, start) === prefix &&
        content.substring(end, end + suffix.length) === suffix
      ) {
        shouldRemove = true
        removeStart = start - prefix.length
        removeEnd = end + suffix.length
      }
    } else {
      // No selection - check if cursor is inside formatted text
      const beforeCursor = content.substring(0, start)
      const afterCursor = content.substring(start)

      const prefixIndex = beforeCursor.lastIndexOf(prefix)
      if (prefixIndex !== -1) {
        const suffixIndex = afterCursor.indexOf(suffix)
        if (suffixIndex !== -1) {
          const textBetweenPrefixAndCursor = beforeCursor.substring(prefixIndex + prefix.length)
          const textBetweenCursorAndSuffix = afterCursor.substring(0, suffixIndex)

          if (!textBetweenPrefixAndCursor.includes(suffix) && !textBetweenCursorAndSuffix.includes(prefix)) {
            shouldRemove = true
            removeStart = prefixIndex
            removeEnd = start + suffixIndex + suffix.length
          }
        }
      }
    }

    let newContent: string
    let newCursorPos: number

    if (shouldRemove) {
      // Remove the formatting
      const innerText = content.substring(removeStart + prefix.length, removeEnd - suffix.length)
      newContent = content.substring(0, removeStart) + innerText + content.substring(removeEnd)
      newCursorPos = removeStart + innerText.length
    } else {
      // Add the formatting
      const insertText = prefix + selectedText + suffix
      newContent = content.substring(0, start) + insertText + content.substring(end)
      newCursorPos = selectedText
        ? start + insertText.length
        : start + prefix.length
    }

    // Update content via React state
    onContentChange(newContent)

    // Restore focus and cursor position after React re-renders
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(newCursorPos, newCursorPos)
    })
  }

  const isPosted = !!post.postedPostId

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, height: 0 }}
      transition={{ duration: 0.2 }}
      className={`relative ${index > 0 ? 'mt-0' : ''}`}
    >
      {/* Thread connector line */}
      {index > 0 && (
        <div className={`absolute left-5 -top-3 w-0.5 h-3 bg-gradient-to-b ${
          isPosted
            ? 'from-green-300 to-green-400 dark:from-green-700 dark:to-green-600'
            : 'from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-600'
        }`} />
      )}

      <div
        onClick={isPosted ? undefined : onActivate}
        className={`relative rounded-xl border-2 transition-all ${
          isPosted
            ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/30 cursor-default'
            : isActive
            ? 'border-yappr-500 bg-white dark:bg-neutral-900 shadow-sm cursor-pointer'
            : 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950 hover:border-gray-300 dark:hover:border-gray-700 cursor-pointer'
        }`}
      >
        {/* Post number/status indicator */}
        <div className={`absolute -left-2 top-3 flex items-center justify-center w-6 h-6 rounded-full text-white text-xs font-semibold shadow-sm ${
          isPosted ? 'bg-green-500' : 'bg-yappr-500'
        }`}>
          {isPosted ? (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            index + 1
          )}
        </div>

        <div className="p-4 pl-8">
          {/* Posted status badge */}
          {isPosted && (
            <div className="flex items-center gap-2 mb-2 text-xs text-green-600 dark:text-green-400 font-medium">
              <span>Posted</span>
            </div>
          )}

          {/* Formatting toolbar - only show when active and not posted */}
          {isActive && !showPreview && !isPosted && (
            <div className="flex items-center gap-1 mb-3 pb-2 border-b border-gray-100 dark:border-gray-800">
              <FormatButton
                onClick={() => handleInsertFormat('**')}
                title="Bold (Ctrl+B)"
              >
                <span className="font-bold text-sm">B</span>
              </FormatButton>
              <FormatButton
                onClick={() => handleInsertFormat('*')}
                title="Italic (Ctrl+I)"
              >
                <span className="italic text-sm">I</span>
              </FormatButton>
              <FormatButton
                onClick={() => handleInsertFormat('`')}
                title="Code"
              >
                <span className="font-mono text-xs">&lt;/&gt;</span>
              </FormatButton>
              <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
              <FormatButton
                onClick={() => handleInsertFormat('@', '')}
                title="Mention someone"
              >
                <span className="text-sm">@</span>
              </FormatButton>
              <FormatButton
                onClick={() => handleInsertFormat('#', '')}
                title="Add hashtag"
              >
                <span className="text-sm">#</span>
              </FormatButton>

              {/* Remove button for thread posts */}
              {!isOnly && (
                <>
                  <div className="flex-1" />
                  <FormatButton onClick={onRemove} title="Remove this post">
                    <TrashIcon className="w-4 h-4 text-red-500" />
                  </FormatButton>
                </>
              )}
            </div>
          )}

          {/* Content area */}
          {showPreview || isPosted ? (
            <div className={`min-h-[60px] whitespace-pre-wrap break-words ${
              isPosted
                ? 'text-gray-600 dark:text-gray-400'
                : 'text-gray-900 dark:text-gray-100'
            }`}>
              {post.content ? (
                <MarkdownContent content={post.content} />
              ) : (
                <span className="text-gray-400 dark:text-gray-600 italic">
                  Nothing to preview
                </span>
              )}
            </div>
          ) : (
            <textarea
              ref={ref}
              value={post.content}
              onChange={(e) => onContentChange(e.target.value)}
              onFocus={onActivate}
              onKeyDown={(e) => {
                // Formatting shortcuts
                if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                  e.preventDefault()
                  handleInsertFormat('**')
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
                  e.preventDefault()
                  handleInsertFormat('*')
                }
              }}
              placeholder={
                index === 0
                  ? "What's on your mind?"
                  : 'Continue your thread...'
              }
              className="w-full min-h-[80px] text-base resize-none outline-none bg-transparent placeholder:text-gray-400 dark:placeholder:text-gray-600"
              style={{ height: 'auto' }}
            />
          )}

          {/* Footer with formatting hints and character count - hide for posted */}
          {!isPosted && (
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">**bold**</code>
                <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">*italic*</code>
                <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">`code`</code>
              </div>
              <CharacterCounter current={post.content.length} limit={CHARACTER_LIMIT} />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

export function ComposeModal() {
  const {
    isComposeOpen,
    setComposeOpen,
    replyingTo,
    setReplyingTo,
    quotingPost,
    setQuotingPost,
    threadPosts,
    activeThreadPostId,
    addThreadPost,
    removeThreadPost,
    updateThreadPost,
    markThreadPostAsPosted,
    setActiveThreadPost,
    resetThreadPosts,
  } = useAppStore()

  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const [isPosting, setIsPosting] = useState(false)
  const [postingProgress, setPostingProgress] = useState<{
    current: number
    total: number
    status: string
  } | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [isMac, setIsMac] = useState(true) // Default to Mac symbol, will detect on mount
  const firstTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Detect platform for keyboard shortcut hints
  useEffect(() => {
    setIsMac(typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform))
  }, [])

  // Focus first textarea when modal opens
  useEffect(() => {
    if (isComposeOpen) {
      const timeoutId = setTimeout(() => {
        firstTextareaRef.current?.focus()
      }, 100)
      return () => clearTimeout(timeoutId)
    }
  }, [isComposeOpen])

  // Calculate totals (only for unposted posts)
  const unpostedPosts = threadPosts.filter((p) => !p.postedPostId)
  const postedPosts = threadPosts.filter((p) => p.postedPostId)
  const totalCharacters = threadPosts.reduce((sum, p) => sum + p.content.length, 0)
  const hasValidContent = unpostedPosts.some((p) => p.content.trim().length > 0)
  const hasOverLimit = unpostedPosts.some((p) => p.content.length > CHARACTER_LIMIT)
  const canPost = hasValidContent && !hasOverLimit && !isPosting
  const canAddThread = threadPosts.length < 10 && !replyingTo && !quotingPost

  // Get the last posted post ID for chaining retries
  const lastPostedId = postedPosts.length > 0
    ? postedPosts[postedPosts.length - 1].postedPostId
    : null

  // Helper to extract error message from various error formats
  const extractErrorMessage = (error: unknown): string => {
    if (!error) return 'Unknown error'
    if (typeof error === 'string') return error
    if (error instanceof Error) return error.message

    // Handle nested error objects
    const err = error as Record<string, unknown>
    if (err.message && typeof err.message === 'string') return err.message
    if (err.error) return extractErrorMessage(err.error)
    if (err.cause) return extractErrorMessage(err.cause)

    // Try to stringify, but avoid [object Object]
    try {
      const str = JSON.stringify(error)
      if (str && str !== '{}') return str.slice(0, 200)
    } catch {
      // Ignore stringify errors
    }

    return 'Unknown error'
  }

  // Check if error is a timeout that might mean success
  const isTimeoutError = (error: unknown): boolean => {
    const msg = extractErrorMessage(error).toLowerCase()
    return (
      msg.includes('timeout') ||
      msg.includes('deadline') ||
      msg.includes('expired') ||
      msg.includes('timed out')
    )
  }

  const handlePost = async () => {
    const authedUser = requireAuth('post')
    if (!authedUser || !canPost) return

    setIsPosting(true)
    setPostingProgress(null)

    // Track successful posts for partial success reporting
    interface SuccessfulPost {
      index: number
      postId: string
      content: string
      threadPostId: string // The original threadPost.id from the store
    }
    const successfulPosts: SuccessfulPost[] = []
    const timeoutPosts: { index: number; threadPostId: string }[] = [] // Posts that timed out (may have succeeded)
    let failedAtIndex: number | null = null
    let failureError: Error | null = null

    try {
      const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
      const { retryPostCreation } = await import('@/lib/retry-utils')

      // Filter to only unposted posts with content, preserving their IDs
      const postsToCreate = threadPosts
        .filter((p) => p.content.trim().length > 0 && !p.postedPostId)
        .map((p) => ({ threadPostId: p.id, content: p.content.trim() }))

      setPostingProgress({ current: 0, total: postsToCreate.length, status: 'Starting...' })

      // Use lastPostedId for retry chaining, or replyingTo for initial post
      let previousPostId: string | null = lastPostedId || replyingTo?.id || null

      for (let i = 0; i < postsToCreate.length; i++) {
        const { threadPostId, content: postContent } = postsToCreate[i]

        setPostingProgress({
          current: i + 1,
          total: postsToCreate.length,
          status: `Creating post ${i + 1} of ${postsToCreate.length}...`
        })

        console.log(`Creating post ${i + 1}/${postsToCreate.length}...`)

        const result = await retryPostCreation(async () => {
          const dashClient = getDashPlatformClient()
          return await dashClient.createPost(postContent, {
            replyToPostId: previousPostId || undefined,
            quotedPostId: i === 0 ? quotingPost?.id : undefined,
          })
        })

        if (result.success) {
          // Get the post ID for threading
          const postId =
            result.data?.documentId ||
            result.data?.document?.$id ||
            result.data?.document?.id ||
            result.data?.$id ||
            result.data?.id

          if (postId) {
            // Track successful post with its original threadPost ID
            successfulPosts.push({ index: i, postId, content: postContent, threadPostId })

            // Update previousPostId for thread chaining
            previousPostId = postId

            setPostingProgress({
              current: i + 1,
              total: postsToCreate.length,
              status: `Post ${i + 1} created, processing hashtags...`
            })

            // Create hashtag documents for this successful post
            const hashtags = extractAllTags(postContent)
            if (hashtags.length > 0) {
              hashtagService.createPostHashtags(postId, authedUser.identityId, hashtags)
                .then((results) => {
                  const successCount = results.filter((r) => r).length
                  console.log(`Post ${i + 1}: Created ${successCount}/${hashtags.length} hashtag documents`)

                  results.forEach((success, tagIndex) => {
                    if (success) {
                      window.dispatchEvent(
                        new CustomEvent('hashtag-registered', {
                          detail: { postId, hashtag: hashtags[tagIndex] },
                        })
                      )
                    }
                  })
                })
                .catch((err) => {
                  console.error(`Post ${i + 1}: Failed to create hashtag documents:`, err)
                })
            }

            // Dispatch event for first post
            if (i === 0) {
              window.dispatchEvent(
                new CustomEvent('post-created', {
                  detail: { post: result.data },
                })
              )
            }
          } else {
            // Post created but no ID returned - treat as failure for threading
            failedAtIndex = i
            failureError = new Error(`Post ${i + 1} created but no ID returned for threading`)
            break
          }
        } else {
          // Check if this is a timeout error - might have actually succeeded
          if (isTimeoutError(result.error)) {
            console.warn(`Post ${i + 1} timed out - may have succeeded. Continuing...`)
            timeoutPosts.push({ index: i, threadPostId })
            // Continue with last known good previousPostId for subsequent posts
            // Timed-out posts are kept for retry - user can press Post again
            continue
          }

          // Post creation failed
          failedAtIndex = i
          failureError = new Error(extractErrorMessage(result.error))
          break
        }
      }

      // Handle results based on success/failure/timeout state
      const allSuccessful = failedAtIndex === null && timeoutPosts.length === 0
      const hasTimeouts = timeoutPosts.length > 0
      const successfulThreadPostIds = new Set(successfulPosts.map(p => p.threadPostId))

      if (allSuccessful) {
        // Complete success - all posts created without issues
        setPostingProgress({ current: postsToCreate.length, total: postsToCreate.length, status: 'Complete!' })

        if (postsToCreate.length > 1) {
          toast.success(`Thread with ${postsToCreate.length} posts created!`)
        } else {
          toast.success('Post created successfully!')
        }

        // Dispatch thread completion event
        if (successfulPosts.length > 1) {
          window.dispatchEvent(
            new CustomEvent('thread-created', {
              detail: {
                posts: successfulPosts,
                totalPosts: successfulPosts.length,
              },
            })
          )
        }

        handleClose()
      } else if (hasTimeouts && failedAtIndex === null) {
        // Some posts timed out but no hard failures
        // Mark confirmed posts as posted, keep timed-out for retry
        const timeoutCount = timeoutPosts.length
        const confirmedCount = successfulPosts.length

        // Mark confirmed successful posts as posted
        successfulPosts.forEach(({ threadPostId, postId }) => {
          markThreadPostAsPosted(threadPostId, postId)
        })

        if (confirmedCount > 0 && timeoutCount > 0) {
          toast(
            `${confirmedCount} post${confirmedCount > 1 ? 's' : ''} confirmed. ` +
            `${timeoutCount} post${timeoutCount > 1 ? 's' : ''} timed out - press Post to retry.`,
            { duration: 5000, icon: '⚠️' }
          )
          // Keep modal open for retry - set active to first timed-out post
          const firstTimeout = timeoutPosts[0]
          if (firstTimeout) {
            setActiveThreadPost(firstTimeout.threadPostId)
          }
        } else if (timeoutCount > 0) {
          toast(
            `${timeoutCount} post${timeoutCount > 1 ? 's' : ''} timed out. ` +
            `Press Post to retry, or check your profile.`,
            { duration: 5000, icon: '⚠️' }
          )
          // Keep modal open for retry
        } else {
          // All confirmed, close
          handleClose()
        }
      } else if (successfulPosts.length > 0 || timeoutPosts.length > 0) {
        // Partial failure - some posts succeeded or timed out, but at least one failed
        window.dispatchEvent(
          new CustomEvent('thread-partial-success', {
            detail: {
              successfulPosts,
              timeoutPosts,
              failedAtIndex,
              totalAttempted: postsToCreate.length,
              error: failureError?.message,
            },
          })
        )

        // Mark confirmed successful posts as posted (keep visible but finalized)
        successfulPosts.forEach(({ threadPostId, postId }) => {
          markThreadPostAsPosted(threadPostId, postId)
        })

        // Build informative message
        const parts: string[] = []
        if (successfulPosts.length > 0) {
          parts.push(`${successfulPosts.length} posted`)
        }
        if (timeoutPosts.length > 0) {
          parts.push(`${timeoutPosts.length} timed out`)
        }
        const successPart = parts.join(', ')

        const errorMsg = failureError?.message || 'Unknown error'
        toast.error(
          `Thread partially created: ${successPart}. ` +
          `Post ${(failedAtIndex ?? 0) + 1} failed: ${errorMsg}. Press Post to retry.`,
          { duration: 6000 }
        )

        // Set active to first unposted post for retry
        const firstUnposted = threadPosts.find(p => !successfulThreadPostIds.has(p.id))
        if (firstUnposted) {
          setActiveThreadPost(firstUnposted.id)
        }
      } else {
        // Complete failure on first post
        throw failureError || new Error('Post creation failed')
      }
    } catch (error) {
      console.error('Failed to create post:', error)

      const errorMessage = extractErrorMessage(error)

      if (
        errorMessage.includes('no available addresses') ||
        errorMessage.includes('Missing response message')
      ) {
        toast.error('Dash Platform is temporarily unavailable. Please try again in a few moments.')
      } else if (
        errorMessage.includes('Network') ||
        errorMessage.includes('connection') ||
        errorMessage.includes('timeout')
      ) {
        toast.error('Network error. Please check your connection and try again.')
      } else if (
        errorMessage.includes('Private key not found') ||
        errorMessage.includes('Not logged in')
      ) {
        toast.error('Your session has expired. Please log in again.')
      } else {
        toast.error(`Failed to create post: ${errorMessage}`)
      }
    } finally {
      setIsPosting(false)
      setPostingProgress(null)
    }
  }

  const handleClose = () => {
    setComposeOpen(false)
    setReplyingTo(null)
    setQuotingPost(null)
    resetThreadPosts()
    setShowPreview(false)
    setPostingProgress(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void handlePost()
    }
  }

  return (
    <Dialog.Root open={isComposeOpen} onOpenChange={setComposeOpen}>
      <AnimatePresence>
        {isComposeOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-12 sm:pt-20 px-4 overflow-y-auto pb-12"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="w-full max-w-2xl bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={handleKeyDown}
                  >
                    {/* Accessibility */}
                    <Dialog.Title className="sr-only">
                      {replyingTo
                        ? 'Reply to post'
                        : quotingPost
                        ? 'Quote post'
                        : 'Create a new post'}
                    </Dialog.Title>
                    <Dialog.Description className="sr-only">
                      {replyingTo
                        ? 'Write your reply to the post'
                        : quotingPost
                        ? 'Add your thoughts to this quote'
                        : 'Share your thoughts with the community'}
                    </Dialog.Description>

                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <div className="flex items-center gap-3">
                        <IconButton onClick={handleClose} className="hover:bg-gray-200 dark:hover:bg-gray-800">
                          <XMarkIcon className="h-5 w-5" />
                        </IconButton>
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold text-gray-900 dark:text-gray-100">
                            {replyingTo
                              ? 'Reply'
                              : quotingPost
                              ? 'Quote'
                              : threadPosts.length > 1
                              ? `Thread (${threadPosts.length} posts)`
                              : 'New Post'}
                          </h2>
                          {/* Preview toggle */}
                          <button
                            onClick={() => setShowPreview(!showPreview)}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                              showPreview
                                ? 'bg-yappr-100 dark:bg-yappr-900/30 text-yappr-600 dark:text-yappr-400'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                            }`}
                          >
                            {showPreview ? (
                              <>
                                <EyeSlashIcon className="w-3.5 h-3.5" />
                                Edit
                              </>
                            ) : (
                              <>
                                <EyeIcon className="w-3.5 h-3.5" />
                                Preview
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Post button - prominent primary action */}
                        <Button
                          onClick={handlePost}
                          disabled={!canPost}
                          className={`min-w-[100px] h-10 px-5 text-sm font-semibold transition-all ${
                            canPost
                              ? 'bg-yappr-500 hover:bg-yappr-600 shadow-lg shadow-yappr-500/25 hover:shadow-xl hover:shadow-yappr-500/30 hover:scale-[1.02]'
                              : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                          }`}
                        >
                          {isPosting && postingProgress ? (
                            <span className="flex items-center gap-2">
                              <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
                              <span>{postingProgress.current}/{postingProgress.total}</span>
                            </span>
                          ) : isPosting ? (
                            <span className="flex items-center gap-2">
                              <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
                              <span>Posting</span>
                            </span>
                          ) : postedPosts.length > 0 ? (
                            <span className="flex items-center gap-1.5">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              Retry ({unpostedPosts.length})
                            </span>
                          ) : replyingTo ? (
                            <span className="flex items-center gap-1.5">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                              </svg>
                              Reply
                            </span>
                          ) : threadPosts.length > 1 ? (
                            <span className="flex items-center gap-1.5">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16m-7 6h7" />
                              </svg>
                              Post all ({threadPosts.length})
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                              </svg>
                              Post
                            </span>
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* Progress bar when posting */}
                    {isPosting && postingProgress && (
                      <div className="px-4 py-2 bg-yappr-50 dark:bg-yappr-950/30 border-b border-yappr-200 dark:border-yappr-800">
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-yappr-500 rounded-full transition-all duration-300"
                                style={{ width: `${(postingProgress.current / postingProgress.total) * 100}%` }}
                              />
                            </div>
                          </div>
                          <span className="text-xs text-yappr-600 dark:text-yappr-400 font-medium whitespace-nowrap">
                            {postingProgress.status}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Reply context */}
                    {replyingTo && (
                      <div className="px-4 py-3 bg-gray-50 dark:bg-neutral-950 border-b border-gray-200 dark:border-gray-800">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-gray-500">Replying to</span>
                          <span className="text-yappr-500 font-medium">
                            {replyingTo.author.username &&
                            !replyingTo.author.username.startsWith('user_')
                              ? `@${replyingTo.author.username}`
                              : replyingTo.author.displayName &&
                                replyingTo.author.displayName !== 'Unknown User' &&
                                !replyingTo.author.displayName.startsWith('User ')
                              ? replyingTo.author.displayName
                              : `${replyingTo.author.id.slice(0, 8)}...${replyingTo.author.id.slice(-6)}`}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Main content area */}
                    <div className="p-4 max-h-[60vh] overflow-y-auto">
                      <div className="flex gap-3">
                        {/* User avatar */}
                        {user && (
                          <div className="flex-shrink-0">
                            <UserAvatar userId={user.identityId} size="lg" alt="Your avatar" />
                          </div>
                        )}

                        {/* Thread posts */}
                        <div className="flex-1 space-y-4">
                          <AnimatePresence mode="popLayout">
                            {threadPosts.map((post, index) => (
                              <ThreadPostEditor
                                key={post.id}
                                post={post}
                                index={index}
                                isActive={post.id === activeThreadPostId}
                                isOnly={threadPosts.length === 1}
                                showPreview={showPreview}
                                onActivate={() => setActiveThreadPost(post.id)}
                                onRemove={() => removeThreadPost(post.id)}
                                onContentChange={(content) => updateThreadPost(post.id, content)}
                                textareaRef={index === 0 ? firstTextareaRef : undefined}
                              />
                            ))}
                          </AnimatePresence>

                          {/* Add thread post button */}
                          {canAddThread && (
                            <motion.button
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              onClick={addThreadPost}
                              className="flex items-center gap-2 px-4 py-2.5 w-full rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-800 text-gray-500 hover:text-yappr-500 hover:border-yappr-300 dark:hover:border-yappr-700 transition-colors"
                            >
                              <PlusIcon className="w-5 h-5" />
                              <span className="text-sm font-medium">Add to thread</span>
                            </motion.button>
                          )}

                          {/* Quoted post preview */}
                          {quotingPost && (
                            <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50 dark:bg-neutral-950">
                              <div className="flex items-center gap-2 text-sm">
                                <Avatar className="h-5 w-5">
                                  <AvatarImage src={quotingPost.author.avatar} />
                                  <AvatarFallback>
                                    {getInitials(quotingPost.author.displayName)}
                                  </AvatarFallback>
                                </Avatar>
                                <span className="font-semibold text-gray-900 dark:text-gray-100">
                                  {quotingPost.author.displayName}
                                </span>
                                <span className="text-gray-500">
                                  @{quotingPost.author.username}
                                </span>
                                <span className="text-gray-500">·</span>
                                <span className="text-gray-500">
                                  {formatTime(quotingPost.createdAt)}
                                </span>
                              </div>
                              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 line-clamp-3">
                                {quotingPost.content}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Footer - minimal with keyboard hint */}
                    <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <div className="flex items-center justify-end">
                        <span className="text-xs text-gray-400">
                          {threadPosts.length > 1
                            ? `${totalCharacters} total chars · ${isMac ? '⌘' : 'Ctrl'}+Enter to post`
                            : `${isMac ? '⌘' : 'Ctrl'}+Enter to post`}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
