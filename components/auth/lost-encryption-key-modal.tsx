'use client'

import { useState, useCallback, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  XMarkIcon,
  KeyIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  ArrowPathIcon,
  ShieldCheckIcon,
  DocumentTextIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'

interface LostEncryptionKeyModalProps {
  isOpen: boolean
  onClose: () => void
  onFoundKey: () => void
  onResetPrivateFeed: () => void
}

/**
 * LostEncryptionKeyModal Component
 *
 * Help dialog for users who have lost their encryption key.
 * Implements PRD §6.4 - Lost Encryption Key
 */
export function LostEncryptionKeyModal({
  isOpen,
  onClose,
  onFoundKey,
  onResetPrivateFeed,
}: LostEncryptionKeyModalProps) {
  const { user } = useAuth()
  const [hasPrivateFeed, setHasPrivateFeed] = useState<boolean | null>(null)
  const [followedPrivateFeeds, setFollowedPrivateFeeds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Check user's private feed status
  useEffect(() => {
    if (!isOpen || !user) return

    const checkStatus = async () => {
      setIsLoading(true)
      try {
        const { privateFeedService, privateFeedKeyStore } = await import('@/lib/services')

        // Check if user has a private feed enabled
        const hasFeed = await privateFeedService.hasPrivateFeed(user.identityId)
        setHasPrivateFeed(hasFeed)

        // Check what feeds the user follows privately (by checking local keys)
        const followedOwners = privateFeedKeyStore.getFollowedFeedOwners()
        setFollowedPrivateFeeds(followedOwners)
      } catch (error) {
        console.error('Error checking private feed status:', error)
        setHasPrivateFeed(false)
        setFollowedPrivateFeeds([])
      } finally {
        setIsLoading(false)
      }
    }

    checkStatus().catch(console.error)
  }, [isOpen, user])

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

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
                    className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-[500px] max-w-[95vw] max-h-[90vh] overflow-y-auto shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
                      <ExclamationTriangleIcon className="h-6 w-6 text-amber-500" />
                      Lost Your Encryption Key?
                    </Dialog.Title>

                    <button
                      onClick={handleClose}
                      aria-label="Close dialog"
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    {/* Warning box */}
                    <div className="bg-red-50 dark:bg-red-950/30 p-4 rounded-lg mb-6">
                      <p className="text-sm text-red-700 dark:text-red-300">
                        Without your encryption key, you cannot access private feed features.
                        Your encryption key is the only way to decrypt your feed seed (if you&apos;re a feed owner)
                        or decrypt grants (if you follow private feeds).
                      </p>
                    </div>

                    {isLoading ? (
                      <div className="space-y-4">
                        <div className="h-20 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
                        <div className="h-20 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* Option 1: Check secure storage */}
                        <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                          <div className="flex gap-3">
                            <div className="p-2 bg-blue-50 dark:bg-blue-950 rounded-lg h-fit">
                              <DocumentTextIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div className="flex-1">
                              <h3 className="font-semibold text-gray-900 dark:text-white">
                                Check Your Secure Storage
                              </h3>
                              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                                Your encryption key was displayed when you first set it up.
                                Check your password manager, secure notes, or any place you might have saved it.
                              </p>
                              <Button
                                onClick={onFoundKey}
                                variant="outline"
                                size="sm"
                                className="mt-3"
                              >
                                <KeyIcon className="h-4 w-4 mr-2" />
                                I Found My Key
                              </Button>
                            </div>
                          </div>
                        </div>

                        {/* Option 2: Feed Owner - Reset Private Feed */}
                        {hasPrivateFeed && (
                          <div className="p-4 border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 rounded-lg">
                            <div className="flex gap-3">
                              <div className="p-2 bg-red-100 dark:bg-red-950 rounded-lg h-fit">
                                <ArrowPathIcon className="h-5 w-5 text-red-600 dark:text-red-400" />
                              </div>
                              <div className="flex-1">
                                <h3 className="font-semibold text-gray-900 dark:text-white">
                                  Reset Your Private Feed
                                </h3>
                                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                                  As a feed owner, you can reset your private feed with a new encryption key.
                                  This is a destructive action:
                                </p>
                                <ul className="text-sm text-red-600 dark:text-red-400 mt-2 space-y-1 list-disc list-inside">
                                  <li>All current private followers will lose access</li>
                                  <li>All existing private posts become unreadable</li>
                                  <li>Followers must request access again</li>
                                </ul>
                                <Button
                                  onClick={onResetPrivateFeed}
                                  variant="outline"
                                  size="sm"
                                  className="mt-3 text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-950"
                                >
                                  <ArrowPathIcon className="h-4 w-4 mr-2" />
                                  Reset Private Feed
                                </Button>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Option 3: Follower - Request New Access */}
                        {followedPrivateFeeds.length > 0 && (
                          <div className="p-4 border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 rounded-lg">
                            <div className="flex gap-3">
                              <div className="p-2 bg-amber-100 dark:bg-amber-950 rounded-lg h-fit">
                                <UserGroupIcon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                              </div>
                              <div className="flex-1">
                                <h3 className="font-semibold text-gray-900 dark:text-white">
                                  Request New Access
                                </h3>
                                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                                  You follow {followedPrivateFeeds.length} private feed{followedPrivateFeeds.length !== 1 ? 's' : ''}.
                                  Without your key, you cannot decrypt their content.
                                </p>
                                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                                  To regain access, you&apos;ll need to:
                                </p>
                                <ol className="text-sm text-amber-700 dark:text-amber-300 mt-1 space-y-1 list-decimal list-inside">
                                  <li>Add a new encryption key to your identity</li>
                                  <li>Ask each feed owner to revoke and re-approve you</li>
                                </ol>
                                <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
                                  This requires the feed owner&apos;s cooperation.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Help text for users with neither scenario */}
                        {!hasPrivateFeed && followedPrivateFeeds.length === 0 && (
                          <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                            <div className="flex gap-3">
                              <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg h-fit">
                                <ShieldCheckIcon className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                              </div>
                              <div className="flex-1">
                                <h3 className="font-semibold text-gray-900 dark:text-white">
                                  No Recovery Needed
                                </h3>
                                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                                  You don&apos;t have a private feed enabled and aren&apos;t following any private feeds locally.
                                  You can add a new encryption key to your identity to start using private feed features.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Footer */}
                    <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                      <Button onClick={handleClose} variant="outline" className="w-full">
                        <LockClosedIcon className="h-4 w-4 mr-2" />
                        Close
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
