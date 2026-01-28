'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  XMarkIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeSlashIcon,
  ExclamationTriangleIcon,
  LinkIcon,
} from '@heroicons/react/24/outline'
import Image from 'next/image'
import { useAppStore, useSettingsStore, ThreadPost, PostVisibility } from '@/lib/store'
import type { Post } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { usePlatformDetection } from '@/hooks/use-platform-detection'
import { UserAvatar } from '@/components/ui/avatar-image'
import { extractAllTags, extractMentions } from '@/lib/post-helpers'
import { extractFirstUrl, isDirectImageUrl, stripTrailingPunctuation } from '@/hooks/use-link-preview'
import { hashtagService } from '@/lib/services/hashtag-service'
import { mentionService } from '@/lib/services/mention-service'
import { extractErrorMessage, isTimeoutError, categorizeError } from '@/lib/error-utils'
import { MarkdownContent } from '@/components/ui/markdown-content'
import {
  PostingProgress,
  PostButtonContent,
  getPostButtonState,
  PostingProgressBar,
  QuotedPostPreview,
  ReplyContext,
  getModalTitle,
  getDialogTitle,
  getDialogDescription,
} from './compose-sub-components'
import { VisibilitySelector, TEASER_LIMIT } from './visibility-selector'
import { LockClosedIcon, LinkIcon as LinkIconSolid } from '@heroicons/react/24/solid'
import { isPrivatePost } from '@/components/post/private-post-content'
import type { EncryptionSource } from '@/lib/services/post-service'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { MentionAutocomplete } from './mention-autocomplete'
import { EmojiPicker } from './emoji-picker'

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

  function getProgressColor(): string {
    if (isDanger) return 'text-red-500'
    if (isWarning) return 'text-amber-500'
    return 'text-yappr-500'
  }

  if (current === 0) {
    return <div className="flex items-center gap-2" />
  }

  return (
    <div className="flex items-center gap-2">
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
            className={getProgressColor()}
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
  const [imageError, setImageError] = useState(false)

  // Reset image error when content changes
  useEffect(() => {
    setImageError(false)
  }, [post.content])

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

  const handleInsertEmoji = (emoji: string) => {
    const textarea = ref.current
    if (!textarea) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const content = post.content

    const newContent = content.substring(0, start) + emoji + content.substring(end)
    const newCursorPos = start + emoji.length

    onContentChange(newContent)

    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(newCursorPos, newCursorPos)
    })
  }

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
        {/* Post number/status indicator - only show for threads (multiple posts) or posted status */}
        {(!isOnly || isPosted) && (
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
        )}

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
              <EmojiPicker onEmojiSelect={handleInsertEmoji} />

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
            <div className={`min-h-[60px] ${
              isPosted
                ? 'text-gray-600 dark:text-gray-400'
                : 'text-gray-900 dark:text-gray-100'
            }`}>
              {post.content ? (
                (() => {
                  const firstUrl = extractFirstUrl(post.content)
                  const isImageUrl = firstUrl && isDirectImageUrl(firstUrl)

                  // Strip the image URL from content (matching PostContent behavior)
                  // Handle all URL variants: http://, https://, //, www., or protocol-less
                  let displayContent = post.content
                  if (isImageUrl && firstUrl) {
                    try {
                      const parsedUrl = new URL(firstUrl)
                      // Get the path portion (e.g., /path/to/image.jpg)
                      const pathAndQuery = parsedUrl.pathname + parsedUrl.search + parsedUrl.hash
                      // Escape special regex characters in hostname and path
                      const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                      const escapedHost = escapeRegex(parsedUrl.hostname)
                      const escapedPath = escapeRegex(pathAndQuery)
                      // Build regex that matches: optional protocol (http://, https://, //), optional www., hostname, path
                      const urlPattern = new RegExp(
                        `(?:https?:\\/\\/|\\/)?\\/?(www\\.)?${escapedHost}${escapedPath}`,
                        'gi'
                      )
                      displayContent = post.content.replace(urlPattern, '').trim()
                    } catch {
                      // Fallback to simple replacement
                      const cleanUrl = stripTrailingPunctuation(firstUrl)
                      displayContent = post.content.replace(cleanUrl, '').trim()
                    }
                  }

                  // Extract hostname for footer
                  const hostname = isImageUrl && firstUrl ? (() => {
                    try {
                      return new URL(firstUrl).hostname.replace(/^www\./, '')
                    } catch {
                      return firstUrl
                    }
                  })() : null

                  return (
                    <>
                      {displayContent && (
                        <div className="whitespace-pre-wrap break-words">
                          <MarkdownContent content={displayContent} />
                        </div>
                      )}
                      {/* Image preview matching LinkPreview component exactly */}
                      {isImageUrl && firstUrl && (
                        <div className="mt-3">
                          <a
                            href={firstUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="block border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
                          >
                            {!imageError ? (
                              <div className="relative bg-neutral-100 dark:bg-neutral-800">
                                <Image
                                  src={firstUrl}
                                  alt="Image preview"
                                  width={600}
                                  height={400}
                                  className="w-full max-h-[400px] object-contain"
                                  onError={() => setImageError(true)}
                                  unoptimized
                                />
                              </div>
                            ) : (
                              <div className="flex items-center justify-center h-32 bg-neutral-100 dark:bg-neutral-800 text-neutral-400">
                                Failed to load image
                              </div>
                            )}
                            {/* Domain info footer */}
                            <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400 border-t border-neutral-200 dark:border-neutral-700">
                              <LinkIcon className="h-3.5 w-3.5 flex-shrink-0" />
                              <span className="truncate">{hostname}</span>
                            </div>
                          </a>
                        </div>
                      )}
                    </>
                  )
                })()
              ) : (
                <span className="text-gray-400 dark:text-gray-600 italic">
                  Nothing to preview
                </span>
              )}
            </div>
          ) : (
            <div className="relative">
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
              <MentionAutocomplete
                textareaRef={ref}
                content={post.content}
                onSelect={(username, start, end) => {
                  // Replace @partial with @username (keep the @, add space after)
                  const newContent =
                    post.content.substring(0, start) +
                    '@' + username + ' ' +
                    post.content.substring(end)
                  onContentChange(newContent)

                  // Restore focus and position cursor after the mention
                  requestAnimationFrame(() => {
                    const textarea = ref.current
                    if (textarea) {
                      textarea.focus()
                      const newPos = start + 1 + username.length + 1 // @username + space
                      textarea.setSelectionRange(newPos, newPos)
                    }
                  })
                }}
              />
            </div>
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
    updateThreadPostVisibility,
    updateThreadPostTeaser,
    markThreadPostAsPosted,
    setActiveThreadPost,
    resetThreadPosts,
  } = useAppStore()

  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const isMac = usePlatformDetection()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [isPosting, setIsPosting] = useState(false)
  const [postingProgress, setPostingProgress] = useState<PostingProgress | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const firstTextareaRef = useRef<HTMLTextAreaElement>(null)
  const teaserTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Private feed state
  const [hasPrivateFeed, setHasPrivateFeed] = useState(false)
  const [privateFeedLoading, setPrivateFeedLoading] = useState(true)
  const [privateFollowerCount, setPrivateFollowerCount] = useState(0)

  // Enable private feed flow state (Improvement 1)
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [pendingVisibility, setPendingVisibility] = useState<PostVisibility | null>(null)
  const [hasEncryptionKeyOnIdentity, setHasEncryptionKeyOnIdentity] = useState(false)

  // Inherited encryption state for replies to private posts (PRD §5.5)
  const [inheritedEncryption, setInheritedEncryption] = useState<EncryptionSource | null>(null)
  const [inheritedEncryptionLoading, setInheritedEncryptionLoading] = useState(false)
  const [inheritedEncryptionError, setInheritedEncryptionError] = useState(false)

  // Get visibility from first post (visibility only applies to first post)
  const firstPost = threadPosts[0]
  const visibility: PostVisibility = firstPost?.visibility || 'public'
  const isPrivatePostVisibility = visibility === 'private' || visibility === 'private-with-teaser'

  // Determine if this will be encrypted (either explicit private post or inherited from parent)
  const willBeEncrypted = isPrivatePostVisibility || inheritedEncryption !== null

  // Check private feed status and encryption key status when modal opens
  useEffect(() => {
    if (isComposeOpen && user) {
      setPrivateFeedLoading(true)
      const checkPrivateFeed = async () => {
        try {
          const { privateFeedService, privateFeedKeyStore, identityService } = await import('@/lib/services')

          // First check local state (fast) - if local keys exist, user has private feed
          const hasLocalKeys = privateFeedKeyStore.hasFeedSeed()

          // Then verify with platform (authoritative) if local keys don't exist
          let hasPrivate = hasLocalKeys
          if (!hasLocalKeys) {
            hasPrivate = await privateFeedService.hasPrivateFeed(user.identityId)
          }

          setHasPrivateFeed(hasPrivate)

          if (hasPrivate) {
            // Get follower count from recipient map
            const recipientMap = privateFeedKeyStore.getRecipientMap()
            setPrivateFollowerCount(Object.keys(recipientMap).length)
          } else {
            // Reset follower count when no private feed
            setPrivateFollowerCount(0)
          }

          // Check if user has encryption key on identity (for enabling private feed flow)
          if (!hasPrivate) {
            try {
              const identity = await identityService.getIdentity(user.identityId)
              const hasEncKey = identity?.publicKeys?.some(
                (k) => k.purpose === 1 && k.type === 0 && !k.disabledAt
              ) ?? false
              setHasEncryptionKeyOnIdentity(hasEncKey)
            } catch {
              setHasEncryptionKeyOnIdentity(false)
            }
          }
        } catch (error) {
          console.error('Failed to check private feed status:', error)
          setHasPrivateFeed(false)
        } finally {
          setPrivateFeedLoading(false)
        }
      }
      checkPrivateFeed()
    }
  }, [isComposeOpen, user])

  // Check for inherited encryption when replying to a post (PRD §5.5)
  // Extracted as a callback for retry functionality
  const checkInheritedEncryption = useCallback(async (postToCheck: Post) => {
    setInheritedEncryptionLoading(true)
    setInheritedEncryptionError(false)
    try {
      // Check if parent is a private post
      if (isPrivatePost(postToCheck)) {
        // Import getEncryptionSource dynamically
        const { getEncryptionSource } = await import('@/lib/services/post-service')
        const encryptionSource = await getEncryptionSource(postToCheck.id)
        if (encryptionSource) {
          setInheritedEncryption(encryptionSource)
        } else {
          // Failed to get encryption source for private post - block posting
          setInheritedEncryptionError(true)
          setInheritedEncryption(null)
        }
      } else {
        setInheritedEncryption(null)
      }
    } catch (error) {
      console.error('Failed to check inherited encryption:', error)
      // Error fetching encryption source for private post - block posting
      if (isPrivatePost(postToCheck)) {
        setInheritedEncryptionError(true)
      }
      setInheritedEncryption(null)
    } finally {
      setInheritedEncryptionLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isComposeOpen && replyingTo) {
      // Track cancellation for stale async results
      let cancelled = false

      const doCheck = async () => {
        setInheritedEncryptionLoading(true)
        setInheritedEncryptionError(false)
        try {
          if (isPrivatePost(replyingTo)) {
            const { getEncryptionSource } = await import('@/lib/services/post-service')
            const encryptionSource = await getEncryptionSource(replyingTo.id)
            // Check if replyingTo changed while we were fetching
            if (cancelled) return
            if (encryptionSource) {
              setInheritedEncryption(encryptionSource)
            } else {
              setInheritedEncryptionError(true)
              setInheritedEncryption(null)
            }
          } else {
            if (cancelled) return
            setInheritedEncryption(null)
          }
        } catch (error) {
          console.error('Failed to check inherited encryption:', error)
          if (cancelled) return
          if (isPrivatePost(replyingTo)) {
            setInheritedEncryptionError(true)
          }
          setInheritedEncryption(null)
        } finally {
          if (!cancelled) {
            setInheritedEncryptionLoading(false)
          }
        }
      }
      doCheck().catch((err) => console.error('Failed to check inherited encryption:', err))

      // Cleanup: mark as cancelled if replyingTo changes
      return () => {
        cancelled = true
      }
    } else {
      // Reset when not replying
      setInheritedEncryption(null)
      setInheritedEncryptionLoading(false)
      setInheritedEncryptionError(false)
    }
  }, [isComposeOpen, replyingTo])

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

  // For private-with-teaser, also check teaser limit
  const hasTeaserOverLimit = visibility === 'private-with-teaser' &&
    firstPost?.teaser && firstPost.teaser.length > TEASER_LIMIT
  const hasOverLimit = unpostedPosts.some((p) => p.content.length > CHARACTER_LIMIT) || hasTeaserOverLimit

  // Encrypted posts must be single posts (no threads)
  const isValidEncryptedPost = !willBeEncrypted || (unpostedPosts.length <= 1 && threadPosts.length <= 1)
  // Block posting while checking inherited encryption for private post replies, or if check failed
  const isInheritedEncryptionReady = !replyingTo || !isPrivatePost(replyingTo) ||
    (!inheritedEncryptionLoading && !inheritedEncryptionError)
  const canPost = hasValidContent && !hasOverLimit && !isPosting && isValidEncryptedPost && isInheritedEncryptionReady
  // Disable thread for private posts and inherited encryption replies (private posts are single posts only)
  const canAddThread = threadPosts.length < 10 && !replyingTo && !quotingPost && !willBeEncrypted

  // Get the last posted post ID for chaining retries
  const lastPostedId = postedPosts.length > 0
    ? postedPosts[postedPosts.length - 1].postedPostId
    : null

  // Handle request to enable private feed when user selects a private visibility option
  // Note: Not wrapped in useCallback because it references enablePrivateFeedAfterKeyEntry
  // which changes when firstPost/updateThreadPostVisibility change, avoiding stale closure
  const handleEnablePrivateFeedRequest = async (targetVisibility: PostVisibility) => {
    if (!user) return

    // Store the pending visibility so we can auto-select it after enabling
    setPendingVisibility(targetVisibility)

    if (!hasEncryptionKeyOnIdentity) {
      // User needs to add encryption key to identity first
      setShowAddKeyModal(true)
    } else {
      // User has encryption key on identity, prompt them to enter it
      // so we can enable the private feed
      const { useEncryptionKeyModal } = await import('@/hooks/use-encryption-key-modal')
      useEncryptionKeyModal.getState().open('manage_private_feed', async () => {
        // After key entry, enable the private feed
        await enablePrivateFeedAfterKeyEntry(targetVisibility)
      })
    }
  }

  // Enable private feed after encryption key is ready
  const enablePrivateFeedAfterKeyEntry = useCallback(async (targetVisibility: PostVisibility) => {
    if (!user) return

    try {
      const { privateFeedService, privateFeedKeyStore } = await import('@/lib/services')
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')

      // Get the encryption key bytes from secure storage (handles WIF and hex)
      const encryptionPrivateKey = getEncryptionKeyBytes(user.identityId)
      if (!encryptionPrivateKey) {
        toast.error('No encryption key found. Please try again.')
        return
      }

      // Enable private feed
      const result = await privateFeedService.enablePrivateFeed(user.identityId, encryptionPrivateKey)

      if (result.success) {
        setHasPrivateFeed(true)
        // Update visibility to the pending one
        if (firstPost) {
          updateThreadPostVisibility(firstPost.id, targetVisibility)
        }
        toast.success('Private feed enabled!')

        // Get follower count
        const recipientMap = privateFeedKeyStore.getRecipientMap()
        setPrivateFollowerCount(Object.keys(recipientMap).length)
      } else {
        toast.error(result.error || 'Failed to enable private feed')
      }
    } catch (error) {
      console.error('Error enabling private feed:', error)
      toast.error('Failed to enable private feed')
    } finally {
      setPendingVisibility(null)
    }
  }, [user, firstPost, updateThreadPostVisibility])

  // Handle success from AddEncryptionKeyModal
  const handleAddKeySuccess = useCallback(async () => {
    setShowAddKeyModal(false)
    setHasEncryptionKeyOnIdentity(true)

    // Now enable the private feed with the pending visibility
    if (pendingVisibility) {
      await enablePrivateFeedAfterKeyEntry(pendingVisibility)
    }
  }, [pendingVisibility, enablePrivateFeedAfterKeyEntry])

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
      const { retryPostCreation } = await import('@/lib/retry-utils')

      // Check if this is a private post (explicit or inherited)
      const isPrivate = visibility === 'private' || visibility === 'private-with-teaser'
      const hasInheritedEncryption = inheritedEncryption !== null

      // Filter to only unposted posts with content, preserving their IDs
      const postsToCreate = threadPosts
        .filter((p) => p.content.trim().length > 0 && !p.postedPostId)
        .map((p) => ({
          threadPostId: p.id,
          content: p.content.trim(),
          teaser: p.teaser?.trim(),
          visibility: p.visibility,
        }))

      // Enforce single-post for encrypted posts
      if ((isPrivate || hasInheritedEncryption) && postsToCreate.length > 1) {
        toast.error('Encrypted posts cannot be threads. Only the first post will be published.')
        // Trim to first post only for encrypted posts
        postsToCreate.length = 1
      }

      setPostingProgress({ current: 0, total: postsToCreate.length, status: 'Starting...' })

      // Use lastPostedId for retry chaining, or replyingTo for initial post
      let previousPostId: string | null = lastPostedId || replyingTo?.id || null

      for (let i = 0; i < postsToCreate.length; i++) {
        const { threadPostId, content: postContent, teaser, visibility: postVisibility } = postsToCreate[i]
        const isThisPostPrivate = i === 0 && isPrivate
        const isThisReplyInherited = i === 0 && hasInheritedEncryption && !isPrivate

        setPostingProgress({
          current: i + 1,
          total: postsToCreate.length,
          status: isThisPostPrivate || isThisReplyInherited
            ? `Encrypting and creating private ${isThisReplyInherited ? 'reply' : 'post'} ${i + 1}...`
            : `Creating post ${i + 1} of ${postsToCreate.length}...`
        })

        console.log(`Creating post ${i + 1}/${postsToCreate.length}... (private: ${isThisPostPrivate}, inherited: ${isThisReplyInherited})`)

        // Determine encryption options
        let encryptionOptions: import('@/lib/services/post-service').EncryptionOptions | undefined

        if (isThisReplyInherited && inheritedEncryption) {
          // Inherited encryption for replies to private posts (PRD §5.5)
          encryptionOptions = {
            type: 'inherited',
            source: { ownerId: inheritedEncryption.ownerId, epoch: inheritedEncryption.epoch },
          }
        } else if (isThisPostPrivate) {
          // Owner encryption for new private posts
          const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
          const encryptionPrivateKey = getEncryptionKeyBytes(authedUser.identityId) ?? undefined

          encryptionOptions = {
            type: 'owner',
            teaser: postVisibility === 'private-with-teaser' ? teaser : undefined,
            encryptionPrivateKey,
          }
        }

        // Determine if this is a reply (to existing post/reply) or a top-level post
        // - If replyingTo is set: all posts in thread are replies
        // - If replyingTo is not set: first post is a top-level post, subsequent are replies
        const isReply = (i === 0 && replyingTo) || (i > 0 && previousPostId)
        const parentId = i === 0 && replyingTo ? replyingTo.id : previousPostId
        const parentOwnerId = i === 0 && replyingTo
          ? replyingTo.author.id
          : previousPostId ? authedUser.identityId : undefined

        const result = await retryPostCreation(async () => {
          // Check for sync required errors before they get wrapped by retry
          try {
            if (isReply && parentId && parentOwnerId) {
              // Create a reply
              const { replyService } = await import('@/lib/services/reply-service')
              const reply = await replyService.createReply(authedUser.identityId, postContent, parentId, parentOwnerId, {
                encryption: encryptionOptions,
              })
              return { postId: reply.id, document: reply, isReply: true }
            } else {
              // Create a top-level post
              const { postService } = await import('@/lib/services')
              const post = await postService.createPost(authedUser.identityId, postContent, {
                quotedPostId: i === 0 ? quotingPost?.id : undefined,
                quotedPostOwnerId: i === 0 ? quotingPost?.author.id : undefined,
                encryption: encryptionOptions,
              })
              return { postId: post.id, document: post, isReply: false }
            }
          } catch (error) {
            // Check if this is a sync required error - handle it specially
            const errorMsg = error instanceof Error ? error.message : String(error)
            if (errorMsg.startsWith('SYNC_REQUIRED:')) {
              const { useEncryptionKeyModal } = await import('@/hooks/use-encryption-key-modal')
              useEncryptionKeyModal.getState().open('sync_state', () => {
                toast('Please try posting again now that your keys are synced')
              })
              toast.error('Your private feed state needs to sync. Please enter your encryption key.')
              // Throw a special error that we can detect
              const syncError = new Error('SYNC_REQUIRED')
              ;(syncError as Error & { syncRequired: boolean }).syncRequired = true
              throw syncError
            }
            throw error
          }
        })

        // Handle sync required - abort without marking as failure
        if (!result.success && (result.error as Error & { syncRequired?: boolean })?.syncRequired) {
          setIsPosting(false)
          setPostingProgress(null)
          return
        }

        if (result.success) {
          // Get the post ID for threading
          // Type assertion needed due to different result formats from public/private posts
          const data = result.data as Record<string, unknown> | undefined
          const postId = (
            data?.postId || // Private post result format
            data?.documentId ||
            (data?.document as Record<string, unknown> | undefined)?.$id ||
            (data?.document as Record<string, unknown> | undefined)?.id ||
            data?.$id ||
            data?.id
          ) as string | undefined

          if (postId) {
            // Track successful post with its original threadPost ID
            successfulPosts.push({ index: i, postId, content: postContent, threadPostId })

            // Update previousPostId for thread chaining (only for public posts)
            if (!isThisPostPrivate) {
              previousPostId = postId
            }

            setPostingProgress({
              current: i + 1,
              total: postsToCreate.length,
              status: isThisPostPrivate
                ? `Private post created!`
                : `Post ${i + 1} created, processing hashtags...`
            })

            // Create hashtag documents for this successful post
            // For private posts, only index hashtags from the teaser (if any), not the encrypted content
            // This prevents metadata leakage about encrypted content
            const contentForHashtags = isThisPostPrivate
              ? (postVisibility === 'private-with-teaser' && teaser ? teaser : '')
              : isThisReplyInherited
                ? '' // Inherited encryption replies have no public content
                : postContent
            const hashtags = extractAllTags(contentForHashtags)
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

            // Create mention documents for this successful post
            // Same privacy consideration: only index mentions from teaser for private posts
            const contentForMentions = isThisPostPrivate
              ? (postVisibility === 'private-with-teaser' && teaser ? teaser : '')
              : isThisReplyInherited
                ? '' // Inherited encryption replies have no public content
                : postContent
            const mentions = extractMentions(contentForMentions)
            if (mentions.length > 0) {
              mentionService.createPostMentionsFromUsernames(postId, authedUser.identityId, mentions)
                .then((results) => {
                  const successCount = results.filter((r) => r).length
                  console.log(`Post ${i + 1}: Created ${successCount}/${mentions.length} mention documents`)

                  // Dispatch event for each successful mention to trigger cache invalidation
                  results.forEach((success, mentionIndex) => {
                    if (success) {
                      window.dispatchEvent(
                        new CustomEvent('mention-registered', {
                          detail: { postId, username: mentions[mentionIndex] },
                        })
                      )
                    }
                  })
                })
                .catch((err) => {
                  console.error(`Post ${i + 1}: Failed to create mention documents:`, err)
                })
            }

            // Dispatch event for first post/reply
            if (i === 0) {
              const eventData = result.data as Record<string, unknown> | undefined
              const wasReply = eventData?.isReply
              if (wasReply) {
                window.dispatchEvent(
                  new CustomEvent('reply-created', {
                    detail: { reply: eventData?.document },
                  })
                )
              } else {
                window.dispatchEvent(
                  new CustomEvent('post-created', {
                    detail: { post: eventData?.document },
                  })
                )
              }
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
      toast.error(categorizeError(error))
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
      handlePost().catch(err => console.error('Failed to post:', err))
    }
  }

  return (
    <>
    <Dialog.Root open={isComposeOpen} onOpenChange={setComposeOpen}>
      <AnimatePresence>
        {isComposeOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-12 sm:pt-20 px-4 overflow-y-auto pb-12 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
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
                      {getDialogTitle(!!replyingTo, !!quotingPost)}
                    </Dialog.Title>
                    <Dialog.Description className="sr-only">
                      {getDialogDescription(!!replyingTo, !!quotingPost)}
                    </Dialog.Description>

                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <div className="flex items-center gap-3">
                        <IconButton onClick={handleClose} className="hover:bg-gray-200 dark:hover:bg-gray-800">
                          <XMarkIcon className="h-5 w-5" />
                        </IconButton>
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold text-gray-900 dark:text-gray-100">
                            {getModalTitle(!!replyingTo, !!quotingPost, threadPosts.length)}
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
                          <PostButtonContent
                            state={getPostButtonState(
                              isPosting,
                              postingProgress,
                              postedPosts.length > 0,
                              unpostedPosts.length,
                              !!replyingTo,
                              threadPosts.length
                            )}
                          />
                        </Button>
                      </div>
                    </div>

                    {/* Progress bar when posting */}
                    {isPosting && postingProgress && (
                      <PostingProgressBar progress={postingProgress} />
                    )}

                    {/* Reply context */}
                    {replyingTo && <ReplyContext author={replyingTo.author} />}

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
                          {/* Visibility selector - show for new posts or replies to public posts
                              Hide when replying to private posts (inherits parent encryption per PRD §5.5) */}
                          {!(replyingTo && isPrivatePost(replyingTo)) && (
                            <div className="flex items-center gap-3 mb-2">
                              <VisibilitySelector
                                visibility={visibility}
                                onVisibilityChange={(v) => {
                                  if (firstPost) {
                                    updateThreadPostVisibility(firstPost.id, v)
                                  }
                                }}
                                hasPrivateFeed={hasPrivateFeed}
                                privateFeedLoading={privateFeedLoading}
                                privateFollowerCount={privateFollowerCount}
                                disabled={isPosting}
                                onEnablePrivateFeedRequest={handleEnablePrivateFeedRequest}
                              />
                            </div>
                          )}

                          {/* Inherited encryption banner for replies to private posts (PRD §5.5) */}
                          {inheritedEncryption && !isPrivatePostVisibility && (
                            <motion.div
                              initial={{ opacity: 0, y: -10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800"
                            >
                              <LinkIconSolid className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                              <span className="text-sm text-purple-700 dark:text-purple-300">
                                Your reply will be visible to all subscribers of this private feed
                              </span>
                            </motion.div>
                          )}

                          {/* Inherited encryption loading state */}
                          {inheritedEncryptionLoading && replyingTo && isPrivatePost(replyingTo) && (
                            <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
                            >
                              <div className="w-4 h-4 border-2 border-gray-300 dark:border-gray-600 border-t-purple-500 rounded-full animate-spin" />
                              <span className="text-sm text-gray-500 dark:text-gray-400">
                                Checking encryption inheritance...
                              </span>
                            </motion.div>
                          )}

                          {/* Inherited encryption error state */}
                          {inheritedEncryptionError && replyingTo && isPrivatePost(replyingTo) && (
                            <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                            >
                              <div className="flex items-center gap-2">
                                <ExclamationTriangleIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                                <span className="text-sm text-red-700 dark:text-red-300">
                                  Unable to determine encryption inheritance — replies to this private post cannot be posted right now
                                </span>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => replyingTo && checkInheritedEncryption(replyingTo)}
                                disabled={inheritedEncryptionLoading}
                                className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 shrink-0"
                              >
                                Retry
                              </Button>
                            </motion.div>
                          )}

                          {/* Private post banner */}
                          {isPrivatePostVisibility && (
                            <motion.div
                              initial={{ opacity: 0, y: -10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
                            >
                              <LockClosedIcon className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                              <span className="text-sm text-amber-700 dark:text-amber-300">
                                {visibility === 'private'
                                  ? 'This post will be encrypted and only visible to your private followers'
                                  : 'The main content will be encrypted. Teaser will be visible to everyone.'}
                              </span>
                            </motion.div>
                          )}

                          {/* Teaser input for private-with-teaser posts */}
                          {visibility === 'private-with-teaser' && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              className="rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-neutral-900 overflow-hidden"
                            >
                              <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                  Public Teaser (visible to everyone)
                                </span>
                              </div>
                              <div className="p-4">
                                <textarea
                                  ref={teaserTextareaRef}
                                  value={firstPost?.teaser || ''}
                                  onChange={(e) => {
                                    if (firstPost) {
                                      updateThreadPostTeaser(firstPost.id, e.target.value)
                                    }
                                  }}
                                  placeholder="Write a teaser to entice others to request access..."
                                  className="w-full min-h-[60px] text-sm resize-none outline-none bg-transparent placeholder:text-gray-400 dark:placeholder:text-gray-600"
                                  maxLength={TEASER_LIMIT + 50}
                                />
                                <div className="flex items-center justify-end mt-2">
                                  <span className={`text-xs ${
                                    (firstPost?.teaser?.length || 0) > TEASER_LIMIT
                                      ? 'text-red-500'
                                      : (firstPost?.teaser?.length || 0) > TEASER_LIMIT - 20
                                      ? 'text-amber-500'
                                      : 'text-gray-400'
                                  }`}>
                                    {firstPost?.teaser?.length || 0}/{TEASER_LIMIT}
                                  </span>
                                </div>
                              </div>
                            </motion.div>
                          )}

                          {/* Private content label for private-with-teaser */}
                          {visibility === 'private-with-teaser' && (
                            <div className="flex items-center gap-2 mt-2">
                              <LockClosedIcon className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                Private Content (encrypted)
                              </span>
                            </div>
                          )}

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
                          {quotingPost && <QuotedPostPreview post={quotingPost} />}
                        </div>
                      </div>
                    </div>

                    {/* Footer - minimal with keyboard hint */}
                    <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <div className="flex items-center justify-between">
                        {/* Private post indicator */}
                        {isPrivatePostVisibility && (
                          <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <LockClosedIcon className="w-3 h-3" />
                            <span>
                              {privateFollowerCount > 0
                                ? `Visible to ${privateFollowerCount} private follower${privateFollowerCount !== 1 ? 's' : ''}`
                                : 'Only visible to you (no followers yet)'}
                            </span>
                          </div>
                        )}
                        {/* Inherited encryption indicator */}
                        {inheritedEncryption && !isPrivatePostVisibility && (
                          <div className="flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400">
                            <LinkIconSolid className="w-3 h-3" />
                            <span>Reply inherits parent&apos;s encryption</span>
                          </div>
                        )}
                        {!willBeEncrypted && <div />}
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

      {/* Add Encryption Key Modal - shown when user needs to add encryption key to identity */}
      <AddEncryptionKeyModal
        isOpen={showAddKeyModal}
        onClose={() => {
          setShowAddKeyModal(false)
          setPendingVisibility(null)
        }}
        onSuccess={handleAddKeySuccess}
      />
    </>
  )
}
