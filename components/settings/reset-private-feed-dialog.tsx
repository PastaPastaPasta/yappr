'use client'

import { useState, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ExclamationTriangleIcon, ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'

interface ResetPrivateFeedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

/**
 * ResetPrivateFeedDialog Component
 *
 * Implements PRD §9.3 - Reset Private Feed flow
 *
 * This dialog requires the user to:
 * 1. Understand the consequences (all followers lose access, all private posts become unreadable)
 * 2. Enter their encryption key
 * 3. Type "RESET" to confirm
 */
export function ResetPrivateFeedDialog({
  open,
  onOpenChange,
  onSuccess,
}: ResetPrivateFeedDialogProps) {
  const { user } = useAuth()

  // Stats for confirmation
  const [followerCount, setFollowerCount] = useState<number | null>(null)
  const [privatePostCount, setPrivatePostCount] = useState<number | null>(null)
  const [isLoadingStats, setIsLoadingStats] = useState(true)

  // Form state
  const [encryptionKeyInput, setEncryptionKeyInput] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [isResetting, setIsResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load stats when dialog opens
  useEffect(() => {
    if (!open || !user) return

    const loadStats = async () => {
      setIsLoadingStats(true)
      try {
        const { privateFeedService } = await import('@/lib/services')
        const { postService } = await import('@/lib/services')

        // Get follower count
        const followers = await privateFeedService.getPrivateFollowerCount(user.identityId)
        setFollowerCount(followers)

        // Get private post count
        const posts = await postService.getUserPosts(user.identityId)
        const privatePosts = posts.documents.filter(
          (p) => p.encryptedContent !== undefined && p.encryptedContent !== null
        )
        setPrivatePostCount(privatePosts.length)
      } catch (err) {
        console.error('Error loading stats:', err)
        setFollowerCount(0)
        setPrivatePostCount(0)
      } finally {
        setIsLoadingStats(false)
      }
    }

    loadStats().catch((err) => console.error('Failed to load stats:', err))
  }, [open, user])

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setEncryptionKeyInput('')
      setConfirmText('')
      setError(null)
      setIsResetting(false)
    }
  }, [open])

  const handleReset = async () => {
    if (!user) return

    // Validate confirm text
    if (confirmText !== 'RESET') {
      setError('Please type RESET to confirm')
      return
    }

    setIsResetting(true)
    setError(null)

    try {
      // Validate the key matches the encryption key on identity
      const { validateEncryptionKey } = await import('@/lib/crypto/key-validation')
      const validation = await validateEncryptionKey(encryptionKeyInput, user.identityId)

      if (!validation.isValid || !validation.privateKey) {
        setError(validation.error || 'Invalid key')
        setIsResetting(false)
        return
      }

      const { privateFeedService } = await import('@/lib/services')

      // Perform the reset
      const result = await privateFeedService.resetPrivateFeed(user.identityId, validation.privateKey)

      if (result.success) {
        toast.success('Private feed has been reset')
        onOpenChange(false)
        onSuccess()
      } else {
        setError(result.error || 'Failed to reset private feed')
        toast.error(result.error || 'Failed to reset private feed')
      }
    } catch (err) {
      console.error('Error resetting private feed:', err)
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred'
      setError(errorMessage)
      toast.error('Failed to reset private feed')
    } finally {
      setIsResetting(false)
    }
  }

  // WIF is 51-52 chars, hex is 64 chars - accept minimum of 50 to cover both
  const isValid = confirmText === 'RESET' && encryptionKeyInput.trim().length >= 50

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
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
                    className="bg-white dark:bg-neutral-900 rounded-2xl p-6 w-[500px] max-w-[90vw] shadow-xl relative max-h-[90vh] overflow-y-auto"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Close button */}
                    <button
                      onClick={() => onOpenChange(false)}
                      aria-label="Close"
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                      disabled={isResetting}
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    {/* Header */}
                    <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2 text-red-600 dark:text-red-400">
                      <ExclamationTriangleIcon className="h-6 w-6" />
                      Reset Private Feed
                    </Dialog.Title>

                    <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                      This action cannot be undone. Your private feed will be completely reset.
                    </Dialog.Description>

                    {/* Warning box */}
                    <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-4 rounded-lg mb-4">
                      <p className="text-sm font-medium text-red-900 dark:text-red-100 mb-3">
                        This will:
                      </p>
                      <ul className="space-y-2 text-sm text-red-800 dark:text-red-200">
                        <li className="flex gap-2">
                          <span className="text-red-500">•</span>
                          Remove all current private followers
                          {isLoadingStats ? (
                            <span className="text-red-500/60 ml-1">(loading...)</span>
                          ) : followerCount !== null && followerCount > 0 ? (
                            <span className="text-red-500 font-medium ml-1">({followerCount})</span>
                          ) : null}
                        </li>
                        <li className="flex gap-2">
                          <span className="text-red-500">•</span>
                          Make all existing private posts unreadable
                          {isLoadingStats ? (
                            <span className="text-red-500/60 ml-1">(loading...)</span>
                          ) : privatePostCount !== null && privatePostCount > 0 ? (
                            <span className="text-red-500 font-medium ml-1">({privatePostCount})</span>
                          ) : null}
                        </li>
                        <li className="flex gap-2">
                          <span className="text-red-500">•</span>
                          Generate a new encryption key
                        </li>
                      </ul>
                      <p className="text-sm text-red-700 dark:text-red-300 mt-3 border-t border-red-200 dark:border-red-800 pt-3">
                        Current followers will need to request access again and you will need to re-approve them.
                      </p>
                    </div>

                    {/* Encryption key input */}
                    <div className="space-y-2 mb-4">
                      <label className="text-sm font-medium">
                        Enter your encryption private key
                      </label>
                      <Input
                        type="password"
                        placeholder="WIF (cXyz...) or hex (64 chars)"
                        value={encryptionKeyInput}
                        onChange={(e) => {
                          setEncryptionKeyInput(e.target.value)
                          setError(null)
                        }}
                        className="font-mono text-sm"
                        disabled={isResetting}
                      />
                    </div>

                    {/* Confirm text input */}
                    <div className="space-y-2 mb-4">
                      <label className="text-sm font-medium">
                        Type <span className="font-bold text-red-600 dark:text-red-400">RESET</span> to confirm:
                      </label>
                      <Input
                        type="text"
                        placeholder="Type RESET"
                        value={confirmText}
                        onChange={(e) => {
                          setConfirmText(e.target.value.toUpperCase())
                          setError(null)
                        }}
                        className="font-mono text-sm"
                        disabled={isResetting}
                      />
                    </div>

                    {/* Error message */}
                    {error && (
                      <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 p-3 rounded mb-4">
                        {error}
                      </div>
                    )}

                    {/* Footer buttons */}
                    <div className="flex gap-3 justify-end">
                      <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={isResetting}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={handleReset}
                        disabled={!isValid || isResetting}
                        className="bg-red-600 hover:bg-red-700 text-white"
                      >
                        {isResetting ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Resetting...
                          </>
                        ) : (
                          <>
                            <ArrowPathIcon className="h-4 w-4 mr-2" />
                            Reset Private Feed
                          </>
                        )}
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
