'use client'

import { logger } from '@/lib/logger'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, PencilSquareIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useEditPostModal } from '@/hooks/use-edit-post-modal'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { categorizeError } from '@/lib/error-utils'
import { CHARACTER_LIMIT } from '@/components/compose/thread-post-editor'

/**
 * Modal for editing the content of an existing post or reply.
 *
 * Uses document replacement on Dash Platform: only the content field changes,
 * all other stored fields are preserved by the service layer. The platform
 * bumps $revision on replacement, which drives the "(edited)" indicator.
 */
export function EditPostModal() {
  const { isOpen, post, close } = useEditPostModal()
  const { requireAuth } = useRequireAuth()
  const [content, setContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Pre-populate content when the modal opens
  useEffect(() => {
    if (isOpen && post) {
      setContent(post.content)
      // Small delay so the modal animation has mounted the textarea
      const timeoutId = setTimeout(() => {
        textareaRef.current?.focus()
      }, 50)
      return () => clearTimeout(timeoutId)
    }
  }, [isOpen, post])

  const trimmed = content.trim()
  const isUnchanged = !!post && trimmed === post.content.trim()
  const canSave = !!post && trimmed.length > 0 && content.length <= CHARACTER_LIMIT && !isUnchanged && !isSaving

  const handleSave = async () => {
    if (!post || !canSave) return
    const authedUser = requireAuth('post')
    if (!authedUser) return

    setIsSaving(true)
    try {
      const isReply = Boolean(post.parentId)

      if (isReply) {
        const { replyService } = await import('@/lib/services/reply-service')
        await replyService.updateReply(post.id, authedUser.identityId, trimmed)
      } else {
        const { postService } = await import('@/lib/services/post-service')
        await postService.updatePost(post.id, authedUser.identityId, trimmed)
      }

      toast.success(isReply ? 'Reply updated' : 'Post updated')

      // Let mounted cards/pages refresh their displayed content
      window.dispatchEvent(new CustomEvent('post-updated', {
        detail: { postId: post.id, content: trimmed, isReply }
      }))

      close()
    } catch (error) {
      logger.error('Failed to update post:', error)
      toast.error(categorizeError(error))
    } finally {
      setIsSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSave().catch(err => logger.error('Failed to save edit:', err))
    }
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && !isSaving && close()}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white dark:bg-neutral-900 rounded-2xl p-6 w-[500px] max-w-[90vw] shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={handleKeyDown}
                  >
                    <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
                      <PencilSquareIcon className="h-6 w-6 text-yappr-500" />
                      Edit {post?.parentId ? 'reply' : 'post'}
                    </Dialog.Title>

                    <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                      Your changes replace the original content. The post will be marked as edited.
                    </Dialog.Description>

                    {!isSaving && (
                      <button
                        onClick={close}
                        className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                      >
                        <XMarkIcon className="h-5 w-5" />
                      </button>
                    )}

                    <textarea
                      ref={textareaRef}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      placeholder="Edit your post"
                      disabled={isSaving}
                      className="w-full min-h-[120px] text-base resize-none outline-none bg-gray-50 dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-700 focus:border-yappr-500 dark:focus:border-yappr-500 placeholder:text-gray-500 disabled:opacity-60"
                    />

                    <div className="flex items-center justify-between mt-2 mb-4">
                      <span className={`text-xs ${
                        content.length > CHARACTER_LIMIT
                          ? 'text-red-500'
                          : content.length > CHARACTER_LIMIT - 20
                          ? 'text-amber-500'
                          : 'text-gray-400'
                      }`}>
                        {content.length}/{CHARACTER_LIMIT}
                      </span>
                    </div>

                    <div className="flex flex-col gap-3">
                      <Button
                        onClick={() => { handleSave().catch(err => logger.error('Failed to save edit:', err)) }}
                        disabled={!canSave}
                        className="w-full bg-yappr-500 hover:bg-yappr-600 text-white disabled:opacity-50"
                      >
                        {isSaving ? (
                          <span className="flex items-center gap-2">
                            <Spinner size="xs" className="border-current" />
                            Saving...
                          </span>
                        ) : (
                          'Save'
                        )}
                      </Button>
                      <Button
                        onClick={close}
                        variant="outline"
                        disabled={isSaving}
                        className="w-full"
                      >
                        Cancel
                      </Button>
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
