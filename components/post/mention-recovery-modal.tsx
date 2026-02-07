'use client'

import { useCallback, useState, useEffect } from 'react'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, ExclamationTriangleIcon, AtSymbolIcon } from '@heroicons/react/24/outline'
import { ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useMentionRecoveryModal } from '@/hooks/use-mention-recovery-modal'
import { useAuth } from '@/contexts/auth-context'
import { mentionService } from '@/lib/services/mention-service'
import { mentionValidationService } from '@/lib/services/mention-validation-service'
import { dpnsService } from '@/lib/services/dpns-service'
import toast from 'react-hot-toast'

export function MentionRecoveryModal() {
  const { isOpen, post, username, isRegistering, error, close, setRegistering, setError } =
    useMentionRecoveryModal()
  const { user } = useAuth()

  const [resolvedIdentityId, setResolvedIdentityId] = useState<string | null>(null)
  const [isResolving, setIsResolving] = useState(false)

  const isOwner = user?.identityId === post?.author.id

  // Resolve username to identity ID when modal opens
  useEffect(() => {
    if (!username || !isOpen) {
      setResolvedIdentityId(null)
      return
    }

    let cancelled = false
    setIsResolving(true)

    dpnsService.resolveIdentity(username)
      .then(id => {
        if (!cancelled) {
          setResolvedIdentityId(id)
        }
      })
      .catch(err => {
        console.error('Failed to resolve username:', err)
        if (!cancelled) {
          setResolvedIdentityId(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsResolving(false)
        }
      })

    return () => { cancelled = true }
  }, [username, isOpen])

  const handleRegister = useCallback(async () => {
    if (!post || !username || !user || !resolvedIdentityId) return

    setRegistering(true)
    setError(null)

    try {
      const success = await mentionService.createPostMention(
        post.id,
        user.identityId,
        resolvedIdentityId
      )

      if (success) {
        // Invalidate validation cache for this post
        mentionValidationService.invalidateCache(post.id)

        // Dispatch event so the post can revalidate
        window.dispatchEvent(
          new CustomEvent('mention-registered', {
            detail: { postId: post.id, username }
          })
        )

        toast.success(`Mention @${username} registered successfully!`)
        close()
      } else {
        setError('Failed to register mention. Please try again.')
      }
    } catch (err) {
      console.error('Error registering mention:', err)
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setRegistering(false)
    }
  }, [post, username, user, resolvedIdentityId, close, setRegistering, setError])

  const handleClose = () => {
    if (isRegistering) return // Don't allow closing during registration
    close()
  }

  if (!post || !username) return null

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
                    className="bg-white dark:bg-surface-900 rounded-2xl p-6 w-[420px] max-w-[90vw] shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title className="text-xl font-bold mb-4 flex items-center gap-2">
                      <ExclamationTriangleIcon className="h-6 w-6 text-amber-500" />
                      Mention Not Registered
                    </Dialog.Title>

                    <Dialog.Description className="sr-only">
                      The mention @{username} was not properly registered for this post
                    </Dialog.Description>

                    <button
                      onClick={handleClose}
                      className="absolute top-4 right-4 p-2 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-full transition-colors"
                      disabled={isRegistering}
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    {/* Content */}
                    {!isRegistering && !error && (
                      <div className="space-y-4">
                        {/* Mention display */}
                        <div className="flex items-center gap-2 p-3 bg-surface-50 dark:bg-neutral-800 rounded-lg">
                          <AtSymbolIcon className="h-5 w-5 text-yappr-500" />
                          {resolvedIdentityId ? (
                            <Link
                              href={`/user?id=${encodeURIComponent(resolvedIdentityId)}`}
                              className="font-mono text-lg font-medium text-yappr-500 hover:underline"
                              onClick={close}
                            >
                              {username}
                            </Link>
                          ) : (
                            <span className="font-mono text-lg font-medium text-yappr-500">
                              {username}
                            </span>
                          )}
                        </div>

                        {/* Explanation */}
                        <div className="text-surface-500 dark:text-surface-400 space-y-2">
                          <p>
                            This mention wasn&apos;t properly registered when the post was
                            created. This can happen due to network issues.
                          </p>
                          <p className="text-sm">
                            Without registration, this post won&apos;t appear when viewing
                            posts that mention{' '}
                            <span className="font-medium text-yappr-500">
                              @{username}
                            </span>
                            .
                          </p>
                        </div>

                        {/* Resolving state */}
                        {isResolving && (
                          <div className="text-sm text-gray-500 flex items-center gap-2">
                            <Spinner size="sm" />
                            Resolving username...
                          </div>
                        )}

                        {/* Username not found */}
                        {!isResolving && !resolvedIdentityId && (
                          <div className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg">
                            Could not resolve @{username} to a user. The username may not exist on DPNS.
                          </div>
                        )}

                        {/* Action - owner with resolved identity can register */}
                        {isOwner && resolvedIdentityId && (
                          <div className="space-y-3 pt-2">
                            <p className="text-sm text-gray-500">
                              Since you own this post, you can register the mention now.
                            </p>
                            <Button
                              onClick={handleRegister}
                              className="w-full bg-yappr-500 hover:bg-yappr-600 text-white"
                            >
                              Register Mention
                            </Button>
                          </div>
                        )}
                        {/* Owner but username not found - just close */}
                        {isOwner && !resolvedIdentityId && !isResolving && (
                          <div className="pt-2">
                            <Button onClick={close} variant="outline" className="w-full">
                              Close
                            </Button>
                          </div>
                        )}
                        {/* Non-owner - can't register */}
                        {!isOwner && (
                          <div className="pt-2">
                            <p className="text-sm text-gray-500 bg-surface-50 dark:bg-neutral-800 p-3 rounded-lg">
                              Only the post author can register this mention. They can
                              click the warning icon on their post to fix it.
                            </p>
                            <Button onClick={close} variant="outline" className="w-full mt-3">
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
                        <p className="text-surface-500 dark:text-surface-400">
                          Registering mention...
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
