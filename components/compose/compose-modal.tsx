'use client'

import { useState, useRef, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useAppStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { UserAvatar } from '@/components/ui/avatar-image'
import { extractHashtags } from '@/lib/post-helpers'
import { hashtagService } from '@/lib/services/hashtag-service'
import { formatTime } from '@/lib/utils'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials } from '@/lib/utils'

export function ComposeModal() {
  const { isComposeOpen, setComposeOpen, replyingTo, setReplyingTo, quotingPost, setQuotingPost } = useAppStore()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const [content, setContent] = useState('')
  const [isPosting, setIsPosting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  
  const characterLimit = 500
  const remainingCharacters = characterLimit - content.length
  const progressPercentage = (content.length / characterLimit) * 100

  useEffect(() => {
    if (isComposeOpen && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isComposeOpen])

  const handlePost = async () => {
    if (!content.trim() || content.length > characterLimit) return
    const authedUser = requireAuth('post')
    if (!authedUser) return

    setIsPosting(true)
    const postContent = content.trim()

    try {
      const { getDashPlatformClient } = await import('@/lib/dash-platform-client')
      const { retryPostCreation, isNetworkError } = await import('@/lib/retry-utils')

      console.log('Creating post with Dash SDK...')

      // Use retry logic for post creation
      const result = await retryPostCreation(async () => {
        const dashClient = getDashPlatformClient()
        return await dashClient.createPost(postContent, {
          replyToPostId: replyingTo?.id,
          quotedPostId: quotingPost?.id
        })
      })

      if (result.success) {
        toast.success('Post created successfully!')

        // Create hashtag documents for the post
        const hashtags = extractHashtags(postContent)
        // Post ID can be in different fields depending on SDK response format
        // Dash Platform uses $id (with $ prefix) for document IDs
        const postId = result.data?.documentId || result.data?.document?.$id || result.data?.document?.id || result.data?.$id || result.data?.id
        console.log('Post creation result:', { hashtags, postId, resultData: result.data })

        if (hashtags.length > 0 && postId) {
          // Create hashtag documents in background (don't block UI)
          hashtagService.createPostHashtags(postId, authedUser.identityId, hashtags)
            .then(results => {
              const successCount = results.filter(r => r).length
              console.log(`Created ${successCount}/${hashtags.length} hashtag documents`)

              // Dispatch events for each successfully created hashtag so post cards revalidate
              results.forEach((success, index) => {
                if (success) {
                  window.dispatchEvent(
                    new CustomEvent('hashtag-registered', {
                      detail: { postId, hashtag: hashtags[index] }
                    })
                  )
                }
              })
            })
            .catch(err => {
              console.error('Failed to create hashtag documents:', err)
            })
        } else if (hashtags.length > 0) {
          console.warn('Could not create hashtag documents - no post ID found in result:', result)
        }

        // Clear the form and close modal
        setContent('')
        setComposeOpen(false)
        setReplyingTo(null)
        setQuotingPost(null)

        // Trigger feed refresh if possible
        window.dispatchEvent(new CustomEvent('post-created', {
          detail: { post: result.data }
        }))
      } else {
        throw result.error || new Error('Post creation failed')
      }
      
    } catch (error) {
      console.error('Failed to create post:', error)
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      
      if (errorMessage.includes('no available addresses') || errorMessage.includes('Missing response message')) {
        toast.error('Dash Platform is temporarily unavailable. Please try again in a few moments.')
      } else if (errorMessage.includes('Network') || errorMessage.includes('connection') || errorMessage.includes('timeout')) {
        toast.error('Network error. Please check your connection and try again.')
      } else if (errorMessage.includes('Private key not found') || errorMessage.includes('Not logged in')) {
        toast.error('Your session has expired. Please log in again.')
      } else {
        toast.error(`Failed to create post: ${errorMessage}`)
      }
    } finally {
      setIsPosting(false)
    }
  }

  const handleClose = () => {
    setComposeOpen(false)
    setReplyingTo(null)
    setQuotingPost(null)
    setContent('')
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
                className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-20 px-4"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.15 }}
                    className="w-full max-w-[600px] bg-white dark:bg-neutral-900 rounded-2xl shadow-xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                {/* Add Dialog Title for accessibility */}
                <Dialog.Title className="sr-only">
                  {replyingTo ? 'Reply to post' : quotingPost ? 'Quote post' : 'Create a new post'}
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  {replyingTo ? 'Write your reply to the post' : quotingPost ? 'Add your thoughts to this quote' : 'Share your thoughts with the community'}
                </Dialog.Description>
                
                <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
                  <IconButton onClick={handleClose}>
                    <XMarkIcon className="h-5 w-5" />
                  </IconButton>
                  
                  <Button
                    onClick={handlePost}
                    disabled={!content.trim() || content.length > characterLimit || isPosting}
                    size="sm"
                  >
                    {isPosting ? (
                      <span className="flex items-center gap-2">
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
                        {replyingTo ? 'Replying...' : quotingPost ? 'Quoting...' : 'Posting...'}
                      </span>
                    ) : (
                      replyingTo ? 'Reply' : quotingPost ? 'Quote' : 'Post'
                    )}
                  </Button>
                </div>

                <div className="p-4">
                  {replyingTo && (
                    <div className="mb-4 text-sm text-gray-500">
                      Replying to <span className="text-yappr-500">
                        {replyingTo.author.username && !replyingTo.author.username.startsWith('user_')
                          ? `@${replyingTo.author.username}`
                          : replyingTo.author.displayName || `@${replyingTo.author.username}`}
                      </span>
                    </div>
                  )}
                  
                  <div className="flex gap-3">
                    {user && <UserAvatar userId={user.identityId} size="lg" alt="Your avatar" />}

                    <div className="flex-1">
                      <textarea
                        ref={textareaRef}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={replyingTo ? "Post your reply" : quotingPost ? "Add your comment" : "What's happening?"}
                        className="w-full min-h-[120px] text-lg resize-none outline-none bg-transparent placeholder:text-gray-500"
                      />

                      {/* Quoted post preview */}
                      {quotingPost && (
                        <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-xl p-3">
                          <div className="flex items-center gap-2 text-sm">
                            <Avatar className="h-5 w-5">
                              <AvatarImage src={quotingPost.author.avatar} />
                              <AvatarFallback>{getInitials(quotingPost.author.displayName)}</AvatarFallback>
                            </Avatar>
                            <span className="font-semibold text-gray-900 dark:text-gray-100">
                              {quotingPost.author.displayName}
                            </span>
                            <span className="text-gray-500">
                              @{quotingPost.author.username}
                            </span>
                            <span className="text-gray-500">·</span>
                            <span className="text-gray-500">{formatTime(quotingPost.createdAt)}</span>
                          </div>
                          <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 line-clamp-3">
                            {quotingPost.content}
                          </p>
                        </div>
                      )}

                      <div className="mt-4 flex items-center justify-end">
                        <div className="flex items-center gap-3">
                          {content.length > 0 && (
                            <div className="relative">
                              <svg className="h-8 w-8 -rotate-90">
                                <circle
                                  cx="16"
                                  cy="16"
                                  r="12"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  className="text-gray-200 dark:text-gray-800"
                                />
                                <circle
                                  cx="16"
                                  cy="16"
                                  r="12"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeDasharray={`${2 * Math.PI * 12}`}
                                  strokeDashoffset={`${2 * Math.PI * 12 * (1 - progressPercentage / 100)}`}
                                  className={
                                    remainingCharacters < 0
                                      ? 'text-red-500'
                                      : remainingCharacters < 20
                                      ? 'text-yellow-500'
                                      : 'text-yappr-500'
                                  }
                                />
                              </svg>
                              {remainingCharacters < 20 && (
                                <span className={`absolute inset-0 flex items-center justify-center text-xs font-medium ${
                                  remainingCharacters < 0 ? 'text-red-500' : ''
                                }`}>
                                  {remainingCharacters}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
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