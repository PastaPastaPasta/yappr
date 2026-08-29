'use client'

import { logger } from '@/lib/logger'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/ui/avatar-image'
import { CharacterCounter } from '@/components/compose/compose-sub-components'
import { useEditPostModal } from '@/hooks/use-edit-post-modal'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
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
  const { user } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [content, setContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Pre-populate content when the modal opens
  useEffect(() => {
    if (isOpen && post) {
      setContent(post.content)
      // Small delay so the modal animation has mounted the textarea
      const timeoutId = setTimeout(() => {
        const textarea = textareaRef.current
        if (textarea) {
          textarea.focus()
          textarea.setSelectionRange(textarea.value.length, textarea.value.length)
        }
      }, 50)
      return () => clearTimeout(timeoutId)
    }
  }, [isOpen, post])

  // Auto-resize the textarea to fit its content, like the thread composer
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.max(120, textarea.scrollHeight)}px`
  }, [content, isOpen])

  const trimmed = content.trim()
  const isUnchanged = !!post && trimmed === post.content.trim()
  const canSave = !!post && trimmed.length > 0 && content.length <= CHARACTER_LIMIT && !isUnchanged && !isSaving
  const isReply = Boolean(post?.parentId)

  const handleSave = async () => {
    if (!post || !canSave) return
    const authedUser = requireAuth('post')
    if (!authedUser) return

    setIsSaving(true)
    try {
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
                      Edit {isReply ? 'reply' : 'post'}
                    </Dialog.Title>
                    <Dialog.Description className="sr-only">
                      Your changes replace the original content. The {isReply ? 'reply' : 'post'} will be marked as edited.
                    </Dialog.Description>

                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800">
                      <div className="flex items-center gap-3">
                        <IconButton
                          onClick={() => !isSaving && close()}
                          className="hover:bg-gray-200 dark:hover:bg-gray-800"
                        >
                          <XMarkIcon className="h-5 w-5" />
                        </IconButton>
                        {user && (
                          <UserAvatar userId={user.identityId} size="sm" alt="Your avatar" />
                        )}
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          Edit {isReply ? 'reply' : 'post'}
                        </span>
                      </div>

                      <Button
                        onClick={() => { handleSave().catch(err => logger.error('Failed to save edit:', err)) }}
                        disabled={!canSave}
                        className={`min-w-[100px] h-10 px-5 text-sm font-semibold transition-all ${
                          canSave
                            ? 'bg-yappr-500 hover:bg-yappr-600 shadow-lg shadow-yappr-500/25 hover:shadow-xl hover:shadow-yappr-500/30 hover:scale-[1.02]'
                            : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                        }`}
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
                    </div>

                    {/* Main content area */}
                    <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
                      <textarea
                        ref={textareaRef}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={isReply ? 'Edit your reply' : 'Edit your post'}
                        disabled={isSaving}
                        className="w-full min-h-[120px] text-base resize-none outline-none bg-transparent placeholder:text-gray-400 dark:placeholder:text-gray-600 disabled:opacity-60"
                      />

                      {/* Footer with edit note and character count */}
                      <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-100 dark:border-gray-800">
                        <span className="text-xs text-gray-400">
                          Replaces the original — will be marked as edited
                        </span>
                        <CharacterCounter current={content.length} limit={CHARACTER_LIMIT} />
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
