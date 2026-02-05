'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  XMarkIcon,
  PlusIcon,
  EyeIcon,
  EyeSlashIcon,
  ExclamationTriangleIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline'
import { useAppStore, useSettingsStore, PostVisibility } from '@/lib/store'
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
import { hashtagService } from '@/lib/services/hashtag-service'
import { mentionService } from '@/lib/services/mention-service'
import { extractErrorMessage, isTimeoutError, categorizeError } from '@/lib/error-utils'
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
import { Spinner } from '@/components/ui/spinner'
import { ThreadPostEditor, CHARACTER_LIMIT } from './thread-post-editor'
import { VisibilitySelector, TEASER_LIMIT } from './visibility-selector'
import { LockClosedIcon, LinkIcon } from '@heroicons/react/24/solid'
import { isPrivatePost } from '@/components/post/private-post-content'
import type { EncryptionSource } from '@/lib/services/post-service'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { ImageAttachment } from './image-attachment'
import { StorageProviderModal } from './storage-provider-modal'
import { useImageUpload } from '@/hooks/use-image-upload'
import type { UploadResult } from '@/lib/upload'

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

  // Image upload state
  const [attachedImage, setAttachedImage] = useState<{
    file: File
    preview: string
    uploadResult?: UploadResult
  } | null>(null)
  const [showStorageProviderModal, setShowStorageProviderModal] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { upload, isUploading, progress, isProviderConnected, checkProvider } = useImageUpload()

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
      checkPrivateFeed().catch(err => console.error('Failed to check private feed:', err))
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

  // Check upload provider status when modal opens
  useEffect(() => {
    if (isComposeOpen) {
      checkProvider().catch(err => console.error('Failed to check upload provider:', err))
    }
  }, [isComposeOpen, checkProvider])

  // Cleanup preview URL when attachedImage changes or component unmounts
  useEffect(() => {
    return () => {
      if (attachedImage?.preview) {
        URL.revokeObjectURL(attachedImage.preview)
      }
    }
  }, [attachedImage?.preview])

  // Calculate totals (only for unposted posts)
  const unpostedPosts = threadPosts.filter((p) => !p.postedPostId)
  const unpostedPostsWithContent = unpostedPosts.filter((p) => p.content.trim().length > 0)
  const postedPosts = threadPosts.filter((p) => p.postedPostId)
  const imageUrl = attachedImage?.uploadResult?.url
  const imageUrlExtraLength = imageUrl ? imageUrl.length + 2 : 0 // include \n\n separator
  const firstUnpostedPostId = unpostedPostsWithContent[0]?.id
  const totalCharacters = threadPosts.reduce((sum, p) => sum + p.content.length, 0) +
    (unpostedPostsWithContent.length > 0 ? imageUrlExtraLength : 0)
  const hasValidContent = unpostedPostsWithContent.length > 0

  // For private-with-teaser, also check teaser limit
  const hasTeaserOverLimit = visibility === 'private-with-teaser' &&
    firstPost?.teaser && firstPost.teaser.length > TEASER_LIMIT
  const hasOverLimit = unpostedPostsWithContent.some((p, index) =>
    p.content.length + (index === 0 ? imageUrlExtraLength : 0) > CHARACTER_LIMIT
  ) || hasTeaserOverLimit
  const firstUnpostedPost = unpostedPostsWithContent[0]
  const isOverLimitDueToImage = !!firstUnpostedPost &&
    imageUrlExtraLength > 0 &&
    firstUnpostedPost.content.length <= CHARACTER_LIMIT &&
    firstUnpostedPost.content.length + imageUrlExtraLength > CHARACTER_LIMIT
  const imageOverage = isOverLimitDueToImage && firstUnpostedPost
    ? firstUnpostedPost.content.length + imageUrlExtraLength - CHARACTER_LIMIT
    : 0

  // Encrypted posts must be single posts (no threads)
  const isValidEncryptedPost = !willBeEncrypted || (unpostedPosts.length <= 1 && threadPosts.length <= 1)
  // Block posting while checking inherited encryption for private post replies, or if check failed
  const isInheritedEncryptionReady = !replyingTo || !isPrivatePost(replyingTo) ||
    (!inheritedEncryptionLoading && !inheritedEncryptionError)
  const canPost = hasValidContent && !hasOverLimit && !isPosting && !isUploading && isValidEncryptedPost && isInheritedEncryptionReady
  // Disable thread for private posts and inherited encryption replies (private posts are single posts only)
  const canAddThread = threadPosts.length < 10 && !replyingTo && !quotingPost && !willBeEncrypted
  // Check if image attachment is allowed (not including provider connection status)
  const canAttachImage = !attachedImage

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

  // Handle file selection for image attachment
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Reset input so same file can be selected again
    e.target.value = ''

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Only images are supported')
      return
    }

    // Validate file size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be under 10MB')
      return
    }

    // Create preview URL
    const preview = URL.createObjectURL(file)
    setAttachedImage({ file, preview })
    upload(file)
      .then((result) => {
        setAttachedImage(prev => (prev && prev.file === file ? { ...prev, uploadResult: result } : prev))
      })
      .catch((err) => {
        console.error('Failed to upload image:', err)
        toast.error('Failed to upload image')
      })
  }, [upload])

  // Handle removing the attached image
  const handleRemoveImage = useCallback(() => {
    if (attachedImage?.preview) {
      URL.revokeObjectURL(attachedImage.preview)
    }
    setAttachedImage(null)
  }, [attachedImage])

  // Handle image button click - check provider first
  const handleImageButtonClick = useCallback(() => {
    if (!isProviderConnected) {
      setShowStorageProviderModal(true)
      return
    }
    fileInputRef.current?.click()
  }, [isProviderConnected])

  // Handle paste event for image upload from clipboard
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Find an image item in the clipboard
    const imageItem = Array.from(items).find(item => item.type.startsWith('image/'))
    if (!imageItem) return

    // Check if we can attach an image
    if (attachedImage) {
      toast.error('Only one image can be attached per post')
      return
    }
    if (!isProviderConnected) {
      setShowStorageProviderModal(true)
      return
    }

    const file = imageItem.getAsFile()
    if (!file) return

    // Validate file type (should always be image since we checked above, but just in case)
    if (!file.type.startsWith('image/')) {
      toast.error('Only images are supported')
      return
    }

    // Validate file size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be under 10MB')
      return
    }

    // Prevent browser's default paste behavior (e.g., inserting data URL into textarea)
    e.preventDefault()

    // Create preview URL and set attached image
    const preview = URL.createObjectURL(file)
    setAttachedImage({ file, preview })
    upload(file)
      .then((result) => {
        setAttachedImage(prev => (prev && prev.file === file ? { ...prev, uploadResult: result } : prev))
      })
      .catch((err) => {
        console.error('Failed to upload image:', err)
        toast.error('Failed to upload image')
      })
  }, [attachedImage, isProviderConnected, upload])

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

    // Upload image first if attached (and not already uploaded)
    let imageUrl: string | undefined
    if (attachedImage && !attachedImage.uploadResult) {
      try {
        setPostingProgress({ current: 0, total: 1, status: 'Uploading image...' })
        const result = await upload(attachedImage.file)
        setAttachedImage(prev => prev ? { ...prev, uploadResult: result } : null)
        imageUrl = result.url // ipfs://CID
      } catch (err) {
        console.error('Failed to upload image:', err)
        toast.error('Failed to upload image')
        setIsPosting(false)
        setPostingProgress(null)
        return
      }
    } else if (attachedImage?.uploadResult) {
      imageUrl = attachedImage.uploadResult.url
    }

    try {
      const { retryPostCreation } = await import('@/lib/retry-utils')

      // Check if this is a private post (explicit or inherited)
      const isPrivate = visibility === 'private' || visibility === 'private-with-teaser'
      const hasInheritedEncryption = inheritedEncryption !== null

      // Filter to only unposted posts with content, preserving their IDs
      const postsToCreate = threadPosts
        .filter((p) => p.content.trim().length > 0 && !p.postedPostId)
        .map((p, index) => ({
          threadPostId: p.id,
          // Append image URL to first post's content if we have one
          content: index === 0 && imageUrl
            ? `${p.content.trim()}\n\n${imageUrl}`
            : p.content.trim(),
          teaser: p.teaser?.trim(),
          visibility: p.visibility,
        }))

      // Guard against image URL pushing content over the limit
      if (postsToCreate.length > 0 && postsToCreate[0].content.length > CHARACTER_LIMIT) {
        const overBy = postsToCreate[0].content.length - CHARACTER_LIMIT
        toast.error(`Post is ${overBy} characters over the limit once the image URL is included. Trim your text.`)
        setIsPosting(false)
        setPostingProgress(null)
        return
      }

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
    // Clean up image preview URL
    if (attachedImage?.preview) {
      URL.revokeObjectURL(attachedImage.preview)
    }
    setAttachedImage(null)
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
                    onPaste={handlePaste}
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
                              <LinkIcon className="w-4 h-4 text-purple-600 dark:text-purple-400" />
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
                              <Spinner size="sm" className="h-4 w-4 border-purple-500" />
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
                                extraCharacters={post.id === firstUnpostedPostId ? imageUrlExtraLength : 0}
                              />
                            ))}
                          </AnimatePresence>

                          {/* Image attachment preview */}
                          {attachedImage && (
                            <>
                              <ImageAttachment
                                previewUrl={attachedImage.preview}
                                isUploading={isUploading}
                                isUploaded={!!attachedImage.uploadResult}
                                progress={progress}
                                onRemove={handleRemoveImage}
                              />
                              {imageUrlExtraLength > 0 && (
                                <div className={`mt-2 text-xs ${
                                  isOverLimitDueToImage ? 'text-red-600 dark:text-red-400' : 'text-gray-500'
                                }`}>
                                  Image URL adds {imageUrlExtraLength} characters to your post.
                                  {isOverLimitDueToImage && (
                                    <span className="ml-1">
                                      Over limit by {imageOverage}. Trim your text.
                                    </span>
                                  )}
                                </div>
                              )}
                            </>
                          )}

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

                    {/* Footer - with image button and keyboard hint */}
                    <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <div className="flex items-center justify-between">
                        {/* Left side: Image button + indicators */}
                        <div className="flex items-center gap-3">
                          {/* Image attachment button */}
                          <button
                            type="button"
                            onClick={handleImageButtonClick}
                            disabled={!canAttachImage}
                            className={`p-1.5 rounded-md transition-colors ${
                              canAttachImage
                                ? 'text-gray-500 hover:text-yappr-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                            }`}
                            title={attachedImage ? 'Only one image per post' : 'Attach image'}
                          >
                            <PhotoIcon className="w-5 h-5" />
                          </button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleFileSelect}
                            className="hidden"
                          />

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
                              <LinkIcon className="w-3 h-3" />
                              <span>Reply inherits parent&apos;s encryption</span>
                            </div>
                          )}
                        </div>

                        {/* Right side: keyboard hint */}
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

      {/* Storage Provider Modal - shown when trying to attach image without a provider */}
      <StorageProviderModal
        open={showStorageProviderModal}
        onOpenChange={setShowStorageProviderModal}
        onSettingsNavigate={() => setComposeOpen(false)}
      />
    </>
  )
}
