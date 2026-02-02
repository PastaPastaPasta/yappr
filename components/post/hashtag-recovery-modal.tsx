'use client'

import { useCallback } from 'react'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useHashtagRecoveryModal } from '@/hooks/use-hashtag-recovery-modal'
import { useAuth } from '@/contexts/auth-context'
import { hashtagService } from '@/lib/services/hashtag-service'
import { hashtagValidationService } from '@/lib/services/hashtag-validation-service'
import toast from 'react-hot-toast'

export function HashtagRecoveryModal() {
  const { isOpen, post, hashtag, isRegistering, error, close, setRegistering, setError } =
    useHashtagRecoveryModal()
  const { user } = useAuth()

  const isOwner = user?.identityId === post?.author.id

  const handleRegister = useCallback(async () => {
    if (!post || !hashtag || !user) return

    setRegistering(true)
    setError(null)

    try {
      const success = await hashtagService.createPostHashtag(
        post.id,
        user.identityId,
        hashtag
      )

      if (success) {
        // Invalidate validation cache for this post
        hashtagValidationService.invalidateCache(post.id)

        // Dispatch event so the post can revalidate
        window.dispatchEvent(
          new CustomEvent('hashtag-registered', {
            detail: { postId: post.id, hashtag }
          })
        )

        toast.success(`Hashtag #${hashtag} registered successfully!`)
        close()
      } else {
        setError('Failed to register hashtag. Please try again.')
      }
    } catch (err) {
      console.error('Error registering hashtag:', err)
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setRegistering(false)
    }
  }, [post, hashtag, user, close, setRegistering, setError])

  const handleClose = () => {
    if (isRegistering) return // Don't allow closing during registration
    close()
  }

  if (!post || !hashtag) return null

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
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
                    className="bg-white dark:bg-neutral-900 rounded-2xl p-6 w-[420px] max-w-[90vw] shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title className="text-xl font-bold mb-4 flex items-center gap-2">
                      <ExclamationTriangleIcon className="h-6 w-6 text-amber-500" />
                      Hashtag Not Registered
                    </Dialog.Title>

                    <Dialog.Description className="sr-only">
                      The hashtag #{hashtag} was not properly registered for this post
                    </Dialog.Description>

                    <button
                      onClick={handleClose}
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                      disabled={isRegistering}
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    {/* Content */}
                    {!isRegistering && !error && (
                      <div className="space-y-4">
                        {/* Hashtag display */}
                        <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-neutral-800 rounded-lg">
                          <Link
                            href={`/hashtag?tag=${encodeURIComponent(hashtag)}`}
                            className="font-mono text-lg font-medium text-yappr-500 hover:underline"
                            onClick={close}
                          >
                            #{hashtag}
                          </Link>
                        </div>

                        {/* Explanation */}
                        <div className="text-gray-600 dark:text-gray-400 space-y-2">
                          <p>
                            This hashtag wasn&apos;t properly registered when the post was
                            created. This can happen due to network issues.
                          </p>
                          <p className="text-sm">
                            Without registration, this post won&apos;t appear in hashtag
                            searches for{' '}
                            <Link
                              href={`/hashtag?tag=${encodeURIComponent(hashtag)}`}
                              className="font-medium text-yappr-500 hover:underline"
                              onClick={close}
                            >
                              #{hashtag}
                            </Link>
                            .
                          </p>
                        </div>

                        {/* Action */}
                        {isOwner ? (
                          <div className="space-y-3 pt-2">
                            <p className="text-sm text-gray-500">
                              Since you own this post, you can register the hashtag now.
                            </p>
                            <Button
                              onClick={handleRegister}
                              className="w-full bg-yappr-500 hover:bg-yappr-600 text-white"
                            >
                              Register Hashtag
                            </Button>
                          </div>
                        ) : (
                          <div className="pt-2">
                            <p className="text-sm text-gray-500 bg-gray-50 dark:bg-neutral-800 p-3 rounded-lg">
                              Only the post author can register this hashtag. They can
                              click the warning icon on their post to fix it.
                            </p>
                            <Button
                              onClick={close}
                              variant="outline"
                              className="w-full mt-3"
                            >
                              Got it
                            </Button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Registering State */}
                    {isRegistering && (
                      <div className="py-8 text-center space-y-4">
                        <Spinner size="lg" className="mx-auto" />
                        <p className="text-gray-600 dark:text-gray-400">
                          Registering hashtag...
                        </p>
                        <p className="text-xs text-gray-500">
                          Please wait, this may take a moment.
                        </p>
                      </div>
                    )}

                    {/* Error State */}
                    {error && !isRegistering && (
                      <div className="py-4 text-center space-y-4">
                        <ExclamationCircleIcon className="h-16 w-16 text-red-500 mx-auto" />
                        <div>
                          <p className="text-lg font-medium">Registration Failed</p>
                          <p className="text-red-500 text-sm">{error}</p>
                        </div>
                        <div className="flex gap-3">
                          <Button onClick={close} variant="outline" className="flex-1">
                            Close
                          </Button>
                          <Button
                            onClick={() => setError(null)}
                            className="flex-1 bg-yappr-500 hover:bg-yappr-600 text-white"
                          >
                            Try Again
                          </Button>
                        </div>
                      </div>
                    )}
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
