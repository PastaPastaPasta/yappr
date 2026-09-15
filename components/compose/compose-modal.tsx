'use client'

import { logger } from '@/lib/logger'
import { useState, useRef, useEffect, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, PlusIcon, EyeIcon, EyeSlashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon, LinkIcon } from '@heroicons/react/24/solid'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAppStore, useSettingsStore, type PostVisibility } from '@/lib/store'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useComposeImage } from '@/hooks/use-compose-image'
import { useComposePoll } from '@/hooks/use-compose-poll'
import { useComposePrivateFeed } from '@/hooks/use-compose-private-feed'
import { useInheritedEncryption } from '@/hooks/use-inherited-encryption'
import { handleInsufficientYapp } from '@/hooks/use-buy-yapp-modal'
import { extractErrorMessage, categorizeError } from '@/lib/error-utils'
import { buildPollEmbed, pollrPollUrl } from '@/lib/poll-embed'
import { planPosts, publishThread } from '@/lib/compose/publish-thread'
import { CHARACTER_LIMIT } from '@/lib/compose/limits'
import { mediaUrlForContract } from '@/lib/utils/ipfs-gateway'
import { isPrivatePost } from '@/components/post/private-post-content'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/ui/avatar-image'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import {
  type PostingProgress,
  PostButtonContent,
  getPostButtonState,
  PostingProgressBar,
  QuotedPostPreview,
  ReplyContext,
  getDialogTitle,
  getDialogDescription,
} from './compose-sub-components'
import { ThreadPostEditor } from './thread-post-editor'
import { VisibilitySelector, TEASER_LIMIT } from './visibility-selector'
import { ImageAttachment } from './image-attachment'
import { PollEditor, isPollDraftValid, pollDraftEndsAt, pollDraftOptions } from './poll-editor'
import { StorageProviderModal } from './storage-provider-modal'

const TOGGLE = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors'
const TOGGLE_OFF = 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
const BANNER = 'flex items-center gap-2 px-3 py-2 rounded-lg border'

function Banner({ tone, children }: { tone: 'purple' | 'amber' | 'gray'; children: React.ReactNode }) {
  const tones = {
    purple: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800',
    amber: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
    gray: 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
  }
  return (
    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className={`${BANNER} ${tones[tone]}`}>
      {children}
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
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [isPosting, setIsPosting] = useState(false)
  const [postingProgress, setPostingProgress] = useState<PostingProgress | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  // One toggle covers the composer: replies are never individually flagged and
  // only the first item of a thread is a post. Once clicked, the profile seed
  // below must not overwrite the choice.
  const [markSensitive, setMarkSensitive] = useState(false)
  const sensitiveTouchedRef = useRef(false)
  const firstTextareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const firstPost = threadPosts[0]
  const visibility: PostVisibility = firstPost?.visibility || 'public'
  const isPrivateVisibility = visibility === 'private' || visibility === 'private-with-teaser'
  const setFirstPostVisibility = useCallback(
    (v: PostVisibility) => {
      if (firstPost) updateThreadPostVisibility(firstPost.id, v)
    },
    [firstPost, updateThreadPostVisibility]
  )

  const image = useComposeImage(isComposeOpen)
  const privateFeed = useComposePrivateFeed(isComposeOpen, user, setFirstPostVisibility)
  const inherited = useInheritedEncryption(isComposeOpen, replyingTo)
  const willBeEncrypted = isPrivateVisibility || inherited.source !== null
  // A poll post is a single, public, top-level post: the question lives on the
  // public Pollr contract and replies/threads have nowhere to carry the embed.
  const canAttachPoll = !replyingTo && !quotingPost && !willBeEncrypted && threadPosts.length === 1
  const poll = useComposePoll(canAttachPoll)

  // Seed the sensitive toggle from the author's own NSFW profile flag on open.
  useEffect(() => {
    if (!isComposeOpen) return
    sensitiveTouchedRef.current = false
    if (!user) {
      setMarkSensitive(false)
      return
    }
    let cancelled = false
    import('@/lib/services/unified-profile-service')
      .then(({ unifiedProfileService }) => unifiedProfileService.getProfile(user.identityId))
      .then((profile) => {
        if (!cancelled && !sensitiveTouchedRef.current) setMarkSensitive(profile?.nsfw === true)
      })
      .catch(() => {
        // No profile, or the lookup failed: leave the toggle off.
      })
    return () => {
      cancelled = true
    }
  }, [isComposeOpen, user])

  useEffect(() => {
    if (!isComposeOpen) return
    const id = setTimeout(() => firstTextareaRef.current?.focus(), 100)
    return () => clearTimeout(id)
  }, [isComposeOpen])

  const unpostedPosts = threadPosts.filter((p) => !p.postedPostId)
  const unpostedWithContent = unpostedPosts.filter((p) => p.content.trim().length > 0)
  const postedPosts = threadPosts.filter((p) => p.postedPostId)
  const imageUrl = image.attached?.uploadResult?.url
  // Public posts carry the image in the mediaUrl field at no character cost.
  // Encrypted posts keep the URL inside the content, so only they pay for it.
  const imageUrlExtraLength = imageUrl && willBeEncrypted ? imageUrl.length + 2 : 0
  const firstUnposted = unpostedWithContent[0]
  const hasTeaserOverLimit = visibility === 'private-with-teaser' && !!firstPost?.teaser && firstPost.teaser.length > TEASER_LIMIT
  const hasOverLimit = unpostedWithContent.some((p, i) => p.content.length + (i === 0 ? imageUrlExtraLength : 0) > CHARACTER_LIMIT) || hasTeaserOverLimit
  const isOverLimitDueToImage =
    !!firstUnposted && imageUrlExtraLength > 0 && firstUnposted.content.length <= CHARACTER_LIMIT && firstUnposted.content.length + imageUrlExtraLength > CHARACTER_LIMIT
  const imageOverage = isOverLimitDueToImage && firstUnposted ? firstUnposted.content.length + imageUrlExtraLength - CHARACTER_LIMIT : 0

  const isValidEncryptedPost = !willBeEncrypted || threadPosts.length <= 1
  const isInheritedEncryptionReady = !replyingTo || !isPrivatePost(replyingTo) || (!inherited.loading && !inherited.error)
  const canPost =
    unpostedWithContent.length > 0 &&
    !hasOverLimit &&
    !isPosting &&
    !image.isUploading &&
    isValidEncryptedPost &&
    isInheritedEncryptionReady &&
    (!poll.draft || isPollDraftValid(poll.draft))
  const canAddThread = threadPosts.length < 10 && !replyingTo && !quotingPost && !willBeEncrypted && !poll.draft
  const lastPostedId = postedPosts.length > 0 ? postedPosts[postedPosts.length - 1].postedPostId ?? null : null

  const handleClose = () => {
    image.remove()
    // Silent: on the success path the poll is not orphaned, and every failure
    // path in handlePost has already toasted the poll's Pollr link.
    poll.forget()
    setComposeOpen(false)
    setReplyingTo(null)
    setQuotingPost(null)
    resetThreadPosts()
    setShowPreview(false)
    setMarkSensitive(false)
    setPostingProgress(null)
  }

  const stopPosting = () => {
    setIsPosting(false)
    setPostingProgress(null)
  }

  const handlePost = async () => {
    const authedUser = requireAuth()
    if (!authedUser || !canPost) return
    setIsPosting(true)
    // An earlier attempt's poll, so a retry never creates a second one.
    let pollId: string | null = poll.createdPollId

    let uploadedUrl: string | undefined
    try {
      if (image.attached && !image.attached.uploadResult) setPostingProgress({ current: 0, total: 1, status: 'Uploading image...' })
      uploadedUrl = (await image.ensureUploaded()) ?? undefined
    } catch (err) {
      logger.error('Failed to upload image:', err)
      toast.error('Failed to upload image')
      stopPosting()
      return
    }

    try {
      const isPrivate = isPrivateVisibility
      const mediaInEncryptedContent = !!uploadedUrl && (isPrivate || inherited.source !== null)
      const mediaUrlField = uploadedUrl && !mediaInEncryptedContent ? mediaUrlForContract(uploadedUrl) : undefined
      const posts = planPosts(threadPosts, uploadedUrl, mediaInEncryptedContent)

      if (posts.length > 0 && posts[0].content.length > CHARACTER_LIMIT) {
        toast.error(`Post is ${posts[0].content.length - CHARACTER_LIMIT} characters over the limit once the image URL is included. Trim your text.`)
        return
      }
      if (willBeEncrypted && posts.length > 1) {
        toast.error('Encrypted posts cannot be threads. Only the first post will be published.')
        posts.length = 1
      }

      // The poll goes first: it costs credits only, and the post needs its id
      // for the embed. A failure here aborts before anything is spent on the post.
      if (poll.draft && !pollId) {
        setPostingProgress({ current: 0, total: posts.length, status: 'Creating poll...' })
        try {
          const { pollrPollService } = await import('@/lib/services')
          const created = await pollrPollService.createPoll(authedUser.identityId, {
            // The post text is the question, without the appended image URL.
            question: firstUnposted?.content.trim() ?? '',
            options: pollDraftOptions(poll.draft),
            multiChoice: poll.draft.multiChoice,
            endsAt: pollDraftEndsAt(poll.draft),
          })
          pollId = created.id
          poll.setCreatedPollId(created.id)
          // Posting against a poll DAPI never confirmed would spend YAPP on a
          // post pointing at a poll that may not exist; the id is kept for a retry.
          if ((created as unknown as { __createConfirmed?: boolean }).__createConfirmed === false) {
            poll.setUnconfirmed(true)
            toast('Poll not confirmed yet — try again in a moment.', { duration: 6000, icon: '⏳' })
            return
          }
        } catch (error) {
          logger.error('Failed to create poll:', error)
          toast.error(`Poll creation failed: ${extractErrorMessage(error)}`)
          return
        }
      } else if (pollId && poll.unconfirmed) {
        // Not re-created (that would orphan the first and pay twice), but it must
        // be queryable before the post embeds it.
        setPostingProgress({ current: 0, total: posts.length, status: 'Checking poll...' })
        const { pollrPollService } = await import('@/lib/services')
        if (!(await pollrPollService.getPoll(pollId))) {
          toast('Poll still not confirmed — try again in a moment.', { duration: 6000, icon: '⏳' })
          return
        }
        poll.setUnconfirmed(false)
      }

      setPostingProgress({ current: 0, total: posts.length, status: 'Starting...' })
      const outcome = await publishThread({
        authorId: authedUser.identityId,
        posts,
        replyingTo,
        quotingPost,
        lastPostedId,
        knownThreadRootId: threadPosts[0]?.postedPostId ?? null,
        isPrivate,
        inheritedEncryption: inherited.source,
        pollEmbed: pollId ? buildPollEmbed(pollId) : undefined,
        mediaUrlField,
        markSensitive,
        onProgress: setPostingProgress,
      })
      if (outcome.syncRequired) return

      const { successful, timedOut, failedAtIndex, failureError } = outcome
      const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`
      const markPosted = () => successful.forEach(({ threadPostId, postId }) => markThreadPostAsPosted(threadPostId, postId))

      if (failedAtIndex === null && timedOut.length === 0) {
        toast.success(posts.length > 1 ? `Thread with ${posts.length} posts created!` : 'Post created successfully!')
        if (successful.length > 1) {
          window.dispatchEvent(new CustomEvent('thread-created', { detail: { posts: successful, totalPosts: successful.length } }))
        }
        handleClose()
      } else if (failedAtIndex === null) {
        // Timeouts only: keep the modal open so Post retries them.
        markPosted()
        if (successful.length > 0) {
          toast(`${plural(successful.length, 'post')} confirmed. ${plural(timedOut.length, 'post')} timed out - press Post to retry.`, { duration: 5000, icon: '⚠️' })
          setActiveThreadPost(timedOut[0].threadPostId)
        } else {
          toast(`${plural(timedOut.length, 'post')} timed out. Press Post to retry, or check your profile.`, { duration: 5000, icon: '⚠️' })
          if (pollId) {
            const url = pollrPollUrl(pollId)
            toast(`Your poll is live${url ? ` on Pollr: ${url}` : ''}. Retrying re-uses it.`, { duration: 8000, icon: '📊' })
          }
        }
      } else if (successful.length > 0 || timedOut.length > 0) {
        window.dispatchEvent(
          new CustomEvent('thread-partial-success', {
            detail: { successfulPosts: successful, timeoutPosts: timedOut, failedAtIndex, totalAttempted: posts.length, error: failureError?.message },
          })
        )
        markPosted()
        const parts = [successful.length > 0 && `${successful.length} posted`, timedOut.length > 0 && `${timedOut.length} timed out`].filter(Boolean)
        const ranOutOfYapp = handleInsufficientYapp(failureError, 'You ran out of YAPP mid-thread. Buy some to post the rest.')
        const reason = ranOutOfYapp ? 'not enough YAPP' : failureError?.message || 'Unknown error'
        toast.error(`Thread partially created: ${parts.join(', ')}. Post ${failedAtIndex + 1} failed: ${reason}. Press Post to retry.`, { duration: 6000 })
        const done = new Set(successful.map((p) => p.threadPostId))
        const firstUnpostedItem = threadPosts.find((p) => !done.has(p.id))
        if (firstUnpostedItem) setActiveThreadPost(firstUnpostedItem.id)
      } else {
        // Into the catch below, which owns the YAPP and orphaned-poll messaging.
        throw failureError || new Error('Post creation failed')
      }
    } catch (error) {
      logger.error('Failed to create post:', error)
      if (!handleInsufficientYapp(error, 'You need YAPP to post. Buy some to continue.')) toast.error(categorizeError(error))
      // The poll landed even though the post did not; a retry re-uses it.
      if (pollId) {
        const url = pollrPollUrl(pollId)
        toast(`Your poll is already live${url ? ` on Pollr: ${url}` : ''}. Press Post to retry the post.`, { duration: 10000, icon: '📊' })
      }
    } finally {
      stopPosting()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handlePost().catch((err) => logger.error('Failed to post:', err))
    }
  }

  const teaserLength = firstPost?.teaser?.length || 0

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
                      onPaste={image.onPaste}
                    >
                      <Dialog.Title className="sr-only">{getDialogTitle(!!replyingTo, !!quotingPost)}</Dialog.Title>
                      <Dialog.Description className="sr-only">{getDialogDescription(!!replyingTo, !!quotingPost)}</Dialog.Description>

                      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800">
                        <div className="flex items-center gap-3">
                          <IconButton onClick={handleClose} className="hover:bg-gray-200 dark:hover:bg-gray-800">
                            <XMarkIcon className="h-5 w-5" />
                          </IconButton>
                          {user && <UserAvatar userId={user.identityId} size="sm" alt="Your avatar" />}
                          {!(replyingTo && isPrivatePost(replyingTo)) && (
                            <VisibilitySelector
                              visibility={visibility}
                              onVisibilityChange={setFirstPostVisibility}
                              hasPrivateFeed={privateFeed.hasPrivateFeed}
                              privateFeedLoading={privateFeed.loading}
                              privateFollowerCount={privateFeed.followerCount}
                              disabled={isPosting}
                              onEnablePrivateFeedRequest={privateFeed.requestEnable}
                            />
                          )}
                          {!replyingTo && (
                            <button
                              type="button"
                              data-testid="sensitive-toggle"
                              onClick={() => {
                                sensitiveTouchedRef.current = true
                                setMarkSensitive((v) => !v)
                              }}
                              disabled={isPosting}
                              title="Mark this post as NSFW"
                              className={`${TOGGLE} ${markSensitive ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' : TOGGLE_OFF}`}
                            >
                              <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                              NSFW
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => setShowPreview(!showPreview)}
                            className={`${TOGGLE} ${showPreview ? 'bg-yappr-100 dark:bg-yappr-900/30 text-yappr-600 dark:text-yappr-400' : TOGGLE_OFF}`}
                          >
                            {showPreview ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                            {showPreview ? 'Edit' : 'Preview'}
                          </button>
                          <Button
                            data-testid="compose-submit-btn"
                            onClick={handlePost}
                            disabled={!canPost}
                            className={`min-w-[100px] h-10 px-5 text-sm font-semibold transition-all ${
                              canPost
                                ? 'bg-yappr-500 hover:bg-yappr-600 shadow-lg shadow-yappr-500/25 hover:shadow-xl hover:shadow-yappr-500/30'
                                : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                            }`}
                          >
                            <PostButtonContent state={getPostButtonState(isPosting, postingProgress, postedPosts.length > 0, unpostedPosts.length, !!replyingTo, threadPosts.length)} />
                          </Button>
                        </div>
                      </div>

                      {isPosting && postingProgress && <PostingProgressBar progress={postingProgress} />}
                      {replyingTo && <ReplyContext author={replyingTo.author} />}

                      <div ref={scrollContainerRef} className="px-5 py-4 max-h-[60vh] overflow-y-auto">
                        <div className="space-y-4">
                          {inherited.source && !isPrivateVisibility && (
                            <Banner tone="purple">
                              <LinkIcon className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                              <span className="text-sm text-purple-700 dark:text-purple-300">Your reply will be visible to all subscribers of this private feed</span>
                            </Banner>
                          )}
                          {inherited.loading && replyingTo && isPrivatePost(replyingTo) && (
                            <Banner tone="gray">
                              <Spinner size="sm" className="h-4 w-4 border-purple-500" />
                              <span className="text-sm text-gray-500 dark:text-gray-400">Checking encryption inheritance...</span>
                            </Banner>
                          )}
                          {inherited.error && replyingTo && isPrivatePost(replyingTo) && (
                            <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                            >
                              <div className="flex items-center gap-2">
                                <ExclamationTriangleIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                                <span className="text-sm text-red-700 dark:text-red-300">
                                  Unable to determine encryption inheritance — replies to this private post cannot be posted right now.
                                </span>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={inherited.retry}
                                disabled={inherited.loading}
                                className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 shrink-0"
                              >
                                Retry
                              </Button>
                            </motion.div>
                          )}
                          {isPrivateVisibility && (
                            <Banner tone="amber">
                              <LockClosedIcon className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                              <span className="text-sm text-amber-700 dark:text-amber-300">
                                {visibility === 'private'
                                  ? 'This post will be encrypted and only visible to your private followers'
                                  : 'The main content will be encrypted. Teaser will be visible to everyone.'}
                              </span>
                            </Banner>
                          )}

                          {visibility === 'private-with-teaser' && (
                            <>
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                className="rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-neutral-900 overflow-hidden"
                              >
                                <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Public Teaser (visible to everyone)</span>
                                </div>
                                <div className="p-4">
                                  <textarea
                                    value={firstPost?.teaser || ''}
                                    onChange={(e) => firstPost && updateThreadPostTeaser(firstPost.id, e.target.value)}
                                    placeholder="Write a teaser to entice others to request access..."
                                    className="w-full min-h-[60px] text-sm resize-none outline-none bg-transparent placeholder:text-gray-400 dark:placeholder:text-gray-600"
                                    maxLength={TEASER_LIMIT + 50}
                                  />
                                  <div className="flex items-center justify-end mt-2">
                                    <span className={`text-xs ${teaserLength > TEASER_LIMIT ? 'text-red-500' : teaserLength > TEASER_LIMIT - 20 ? 'text-amber-500' : 'text-gray-400'}`}>
                                      {teaserLength}/{TEASER_LIMIT}
                                    </span>
                                  </div>
                                </div>
                              </motion.div>
                              <div className="flex items-center gap-2 mt-2">
                                <LockClosedIcon className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Private Content (encrypted)</span>
                              </div>
                            </>
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
                                // Poll documents are immutable; once one lands the question is fixed.
                                locked={index === 0 && !!poll.createdPollId}
                                textareaRef={index === 0 ? firstTextareaRef : undefined}
                                extraCharacters={post.id === firstUnposted?.id ? imageUrlExtraLength : 0}
                                {...(!post.postedPostId
                                  ? {
                                      onImageClick: image.openPicker,
                                      canAttachImage: !image.attached,
                                      imageTitle: image.attached ? 'Only one image per post' : 'Attach image',
                                      ...(canAttachPoll && index === 0 ? { onPollClick: poll.toggle, pollAttached: !!poll.draft } : {}),
                                    }
                                  : {})}
                              />
                            ))}
                          </AnimatePresence>

                          {poll.draft && <PollEditor draft={poll.draft} onChange={poll.setDraft} onRemove={poll.clear} disabled={isPosting} locked={!!poll.createdPollId} />}

                          {/* Modal-level so the attach button works from any thread post's toolbar. */}
                          <input ref={image.fileInputRef} type="file" accept="image/*" onChange={image.onFileSelect} className="hidden" />

                          {image.attached && (
                            <>
                              <ImageAttachment
                                previewUrl={image.attached.preview}
                                isUploading={image.isUploading}
                                isUploaded={!!image.attached.uploadResult}
                                progress={image.progress}
                                onRemove={image.remove}
                              />
                              {imageUrlExtraLength > 0 && (
                                <div className={`mt-2 text-xs ${isOverLimitDueToImage ? 'text-red-600 dark:text-red-400' : 'text-gray-500'}`}>
                                  Image URL adds {imageUrlExtraLength} characters to your private post.
                                  {isOverLimitDueToImage && <span className="ml-1">Over limit by {imageOverage}. Trim your text.</span>}
                                </div>
                              )}
                            </>
                          )}

                          {canAddThread && (
                            <motion.button
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              onClick={() => {
                                addThreadPost()
                                setTimeout(() => scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: 'smooth' }), 100)
                              }}
                              className="flex items-center gap-2 px-4 py-2.5 w-full rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-800 text-gray-500 hover:text-yappr-500 hover:border-yappr-300 dark:hover:border-yappr-700 transition-colors"
                            >
                              <PlusIcon className="w-5 h-5" />
                              <span className="text-sm font-medium">Add to thread</span>
                            </motion.button>
                          )}

                          {quotingPost && <QuotedPostPreview post={quotingPost} />}
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

      <AddEncryptionKeyModal isOpen={privateFeed.showAddKeyModal} onClose={privateFeed.cancelAddKey} onSuccess={privateFeed.onKeyAdded} />
      <StorageProviderModal open={image.showProviderModal} onOpenChange={image.setShowProviderModal} onSettingsNavigate={() => setComposeOpen(false)} />
    </>
  )
}
