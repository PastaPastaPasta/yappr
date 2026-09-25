'use client'

import { logger } from '@/lib/logger';
import { useId, useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { usePrivateFeedRefreshStore } from '@/lib/stores/private-feed-refresh-store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LockClosedIcon, CheckCircleIcon, UserGroupIcon, ExclamationTriangleIcon, KeyIcon, PlusIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { TREE_CAPACITY, MAX_EPOCH } from '@/lib/services'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { ResetPrivateFeedDialog } from './reset-private-feed-dialog'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'

interface PrivateFeedSettingsProps {
  /** If true, automatically open the reset dialog when component mounts */
  openReset?: boolean
  /** Callback when reset dialog is opened (for clearing URL params) */
  onResetOpened?: () => void
}

/**
 * PrivateFeedSettings Component
 *
 * Settings section for managing private feeds.
 * Implements PRD §4.1 - Enable Private Feed UI
 */
export function PrivateFeedSettings({ openReset = false, onResetOpened }: PrivateFeedSettingsProps) {
  const encryptionKeyId = useId()
  const { user, mergeSecretsIntoAuthVault } = useAuth()
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const refreshKey = usePrivateFeedRefreshStore((state) => state.refreshKey)
  const [isEnabled, setIsEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isEnabling, setIsEnabling] = useState(false)
  const [enabledDate, setEnabledDate] = useState<Date | null>(null)
  const [followerCount, setFollowerCount] = useState(0)
  const [currentEpoch, setCurrentEpoch] = useState(1)
  const [hasEncryptionKeyStored, setHasEncryptionKeyStored] = useState(false)

  // Encryption key input state
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [encryptionKeyInput, setEncryptionKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)

  // Reset dialog state
  const [showResetDialog, setShowResetDialog] = useState(false)

  // Add encryption key modal state
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [hasEncryptionKeyOnIdentity, setHasEncryptionKeyOnIdentity] = useState<boolean | null>(null)

  const checkPrivateFeedStatus = useCallback(async () => {
    if (!user) {
      setIsLoading(false)
      return
    }

    try {
      const { privateFeedService, privateFeedKeyStore } = await import('@/lib/services')
      const { hasEncryptionKey } = await import('@/lib/secure-storage')
      const { identityService } = await import('@/lib/services/identity-service')

      // Check if user has private feed on chain
      const state = await privateFeedService.getPrivateFeedState(user.identityId)
      const hasPrivateFeed = state !== null
      setIsEnabled(hasPrivateFeed)

      // Check if encryption key is stored in session
      setHasEncryptionKeyStored(hasEncryptionKey(user.identityId))

      // Check if user has encryption key on identity (only if not already enabled)
      if (!hasPrivateFeed) {
        const hasKeyOnIdentity = await identityService.hasEncryptionKey(user.identityId)
        setHasEncryptionKeyOnIdentity(hasKeyOnIdentity)
      }

      if (hasPrivateFeed) {
        // Get state document for created date
        if (state?.$createdAt) {
          setEnabledDate(new Date(state.$createdAt))
        }

        // Get current epoch
        const epoch = await privateFeedService.getLatestEpoch(user.identityId)
        setCurrentEpoch(epoch)

        // Get follower count from on-chain grants (authoritative source)
        // Falls back to local recipientMap if on-chain query fails
        try {
          const followers = await privateFeedService.getPrivateFollowers(user.identityId)
          setFollowerCount(followers.length)
        } catch (err) {
          logger.error('Failed to get followers from chain, using local state:', err)
          // Fallback to local storage if on-chain query fails
          if (privateFeedKeyStore.hasFeedSeed()) {
            const recipientMap = privateFeedKeyStore.getRecipientMap()
            setFollowerCount(Object.keys(recipientMap || {}).length)
          }
        }
      }
    } catch (error) {
      logger.error('Error checking private feed status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  useEffect(() => {
    checkPrivateFeedStatus().catch(err => logger.error('Failed to check private feed status:', err))
  }, [checkPrivateFeedStatus, refreshKey])

  // Handle openReset prop - open reset dialog when directed from lost key flow
  useEffect(() => {
    if (openReset && isEnabled && !isLoading) {
      setShowResetDialog(true)
      // Notify parent to clear URL param to prevent dialog re-opening
      onResetOpened?.()
    }
  }, [openReset, isEnabled, isLoading, onResetOpened])

  const handleStartEnable = async () => {
    // Check if we already have the key stored in secure storage
    if (user) {
      const { getEncryptionKey } = await import('@/lib/secure-storage')
      const storedKey = getEncryptionKey(user.identityId)
      if (storedKey) {
        // Pre-populate the key field with the stored key
        setEncryptionKeyInput(storedKey)
      }
    }
    setShowKeyInput(true)
    setKeyError(null)
  }

  const handleCancelEnable = () => {
    setShowKeyInput(false)
    setEncryptionKeyInput('')
    setKeyError(null)
  }

  const handleEnablePrivateFeed = async () => {
    if (!user) return

    setIsEnabling(true)
    setKeyError(null)

    try {
      // Normalize input (trim whitespace) before validation
      const trimmedKey = encryptionKeyInput.trim()

      // Validate the key matches the encryption key on identity
      const { validateEncryptionKey } = await import('@/lib/crypto/key-validation')
      const validation = await validateEncryptionKey(trimmedKey, user.identityId)

      if (!validation.isValid || !validation.privateKey) {
        setKeyError(validation.error || 'Invalid key')
        if (validation.noKeyOnIdentity) {
          setHasEncryptionKeyOnIdentity(false)
          setShowKeyInput(false)
        }
        setIsEnabling(false)
        return
      }

      const { privateFeedService } = await import('@/lib/services')

      // Enable private feed
      const result = await privateFeedService.enablePrivateFeed(user.identityId, validation.privateKey)

      if (result.success) {
        toast.success('Private feed enabled successfully!')
        setShowKeyInput(false)
        setEncryptionKeyInput('')
        // Keep the accepted key available just as the manual key-entry flow does.
        // Storage/backup failures cannot undo the feed that was already enabled.
        try {
          const {
            storeEncryptionKey,
            getEncryptionKey,
            getEncryptionKeyBytes,
            clearEncryptionKey,
            storeEncryptionKeyType,
            clearEncryptionKeyType,
          } = await import('@/lib/secure-storage')
          const { bytesEqual } = await import('@/lib/bytes')
          storeEncryptionKey(user.identityId, trimmedKey)
          const normalizedEncryptionKey = getEncryptionKey(user.identityId)
          // The store swallows write failures, so a non-null readback can still be a stale
          // key left over from an earlier session. Compare the decoded secret with the key
          // that was actually accepted before backing anything up.
          const storedKeyBytes = getEncryptionKeyBytes(user.identityId)
          if (!normalizedEncryptionKey || !storedKeyBytes || !bytesEqual(storedKeyBytes, validation.privateKey)) {
            // Drop any stale key so later private-feed operations cannot pick up a secret
            // that no longer matches the one the chain just accepted.
            clearEncryptionKey(user.identityId)
            clearEncryptionKeyType(user.identityId)
            throw new Error('Encryption key was not saved')
          }
          // A pasted key is recorded as external, matching the add-encryption-key flow.
          storeEncryptionKeyType(user.identityId, 'external')

          try {
            await mergeSecretsIntoAuthVault(user.identityId, { encryptionKeyWif: normalizedEncryptionKey })
          } catch (error) {
            logger.error('Failed to back up encryption key after enabling private feed:', error)
            toast.error('Private feed enabled, but key backup failed. Your key is available for this session.')
          }
        } catch (error) {
          logger.error('Failed to store encryption key after enabling private feed:', error)
          toast.error('Private feed enabled, but your key could not be saved. Enter it again to manage your feed.')
        }
        // Refresh all status to ensure consistent UI state
        await checkPrivateFeedStatus()
      } else {
        setKeyError(result.error || 'Failed to enable private feed')
        toast.error(result.error || 'Failed to enable private feed')
      }
    } catch (error) {
      logger.error('Error enabling private feed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      setKeyError(errorMessage)
      toast.error('Failed to enable private feed')
    } finally {
      setIsEnabling(false)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div data-testid="loading-skeleton" className="animate-pulse space-y-2">
            <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-3/4"></div>
            <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/2"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LockClosedIcon className="h-5 w-5" />
          Private Feed
        </CardTitle>
        <CardDescription>
          Create encrypted posts visible only to approved followers
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isEnabled ? (
          <>
            <div data-testid="private-feed-enabled" className="bg-green-50 dark:bg-green-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-green-900 dark:text-green-100">
                    Private feed is enabled
                  </p>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    You can create encrypted posts that only approved followers can see.
                    {enabledDate && (
                      <span className="block mt-1 text-xs">
                        Enabled: {enabledDate.toLocaleDateString()}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <UserGroupIcon className="h-4 w-4 text-gray-500" />
                </div>
                <p className="text-lg font-semibold">{followerCount}</p>
                <p className="text-xs text-gray-500">/ {TREE_CAPACITY}</p>
                <p className="text-xs text-gray-500">Followers</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg text-center">
                <p className="text-lg font-semibold">{currentEpoch}</p>
                <p className="text-xs text-gray-500">/ {MAX_EPOCH}</p>
                <p className="text-xs text-gray-500">Epoch</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg text-center">
                <p className="text-lg font-semibold">{TREE_CAPACITY - followerCount}</p>
                <p className="text-xs text-gray-500">Available</p>
                <p className="text-xs text-gray-500">Slots</p>
              </div>
            </div>

            {/* Epoch usage warning */}
            {currentEpoch > MAX_EPOCH * 0.9 && (
              <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
                <div className="flex gap-3">
                  <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      Approaching revocation limit
                    </p>
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      Your private feed is approaching its maximum revocation limit.
                      Contact support for migration options.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Encryption Key Status */}
            <div className="pt-4 border-t">
              <h4 className="font-medium mb-3 text-sm flex items-center gap-2">
                <KeyIcon className="h-4 w-4" />
                Encryption Key
              </h4>
              {hasEncryptionKeyStored ? (
                <div className="bg-green-50 dark:bg-green-950 p-3 rounded-lg">
                  <div className="flex items-center gap-2">
                    <CheckCircleIcon className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-sm text-green-700 dark:text-green-300">
                      Key stored for this session
                    </span>
                  </div>
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 ml-6">
                    You can create and view private posts
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="bg-amber-50 dark:bg-amber-950 p-3 rounded-lg">
                    <div className="flex items-center gap-2">
                      <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                      <span className="text-sm text-amber-700 dark:text-amber-300">
                        Key not entered for this session
                      </span>
                    </div>
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 ml-6">
                      Enter your encryption key to manage your private feed
                    </p>
                  </div>
                  <Button
                    data-testid="encryption-key-input"
                    variant="outline"
                    className="w-full"
                    onClick={() => openEncryptionKeyModal('manage_private_feed', checkPrivateFeedStatus)}
                  >
                    <KeyIcon className="h-4 w-4 mr-2" />
                    Enter Encryption Key
                  </Button>
                </div>
              )}
            </div>

            <div className="pt-4 border-t">
              <h4 className="font-medium mb-2 text-sm">Capacity:</h4>
              <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <li className="flex gap-2">
                  <span className="text-yappr-500">•</span>
                  Up to {TREE_CAPACITY.toLocaleString()} private followers
                </li>
                <li className="flex gap-2">
                  <span className="text-yappr-500">•</span>
                  Up to {(MAX_EPOCH - 1).toLocaleString()} revocations before migration needed
                </li>
              </ul>
            </div>

            {/* Private Feed Recovery */}
            <div className="pt-4 border-t">
              <h4 className="font-medium mb-2 text-sm flex items-center gap-2">
                <KeyIcon className="h-4 w-4" />
                Recovery
              </h4>
              <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 rounded-lg">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Reset unavailable</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Your existing private feed cannot be reset. Keep your original encryption key to recover access.
                  </p>
                  <Button
                    data-testid="reset-private-feed-btn"
                    variant="outline"
                    className="mt-2"
                    onClick={() => setShowResetDialog(true)}
                  >
                    View recovery information
                  </Button>
                </div>
              </div>
            </div>

            {/* Reset Dialog */}
            <ResetPrivateFeedDialog
              open={showResetDialog}
              onOpenChange={setShowResetDialog}
            />
          </>
        ) : (
          <>
            {!showKeyInput ? (
              <>
                <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                  <div className="space-y-3">
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      Create a private feed visible only to approved followers
                    </p>
                    <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                      <li className="flex gap-2">
                        <span className="text-yappr-500">•</span>
                        You control who can see your private posts
                      </li>
                      <li className="flex gap-2">
                        <span className="text-yappr-500">•</span>
                        Up to {TREE_CAPACITY.toLocaleString()} private followers
                      </li>
                      <li className="flex gap-2">
                        <span className="text-yappr-500">•</span>
                        Revoke access at any time
                      </li>
                    </ul>
                  </div>
                </div>

                {/* Show different UI based on whether user has encryption key on identity */}
                {hasEncryptionKeyOnIdentity === false ? (
                  <div className="space-y-3">
                    <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
                      <div className="flex gap-3">
                        <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                            Encryption key required
                          </p>
                          <p className="text-sm text-amber-700 dark:text-amber-300">
                            To use private feeds, you need to add an encryption key to your identity first.
                          </p>
                        </div>
                      </div>
                    </div>
                    <Button
                      className="w-full"
                      onClick={() => setShowAddKeyModal(true)}
                    >
                      <PlusIcon className="h-4 w-4 mr-2" />
                      Add Encryption Key to Identity
                    </Button>
                  </div>
                ) : (
                  <Button
                    data-testid="enable-private-feed-btn"
                    className="w-full"
                    onClick={handleStartEnable}
                  >
                    <LockClosedIcon className="h-4 w-4 mr-2" />
                    Enable Private Feed
                  </Button>
                )}
              </>
            ) : (
              <>
                <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
                  <div className="flex gap-3">
                    <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                        Encryption key required
                      </p>
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        Enter your identity encryption private key (WIF or hex format).
                        This key is used to encrypt and decrypt your private feed data.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor={encryptionKeyId} className="text-sm font-medium">
                    Encryption Private Key
                  </label>
                  <Input
                    id={encryptionKeyId}
                    type="password"
                    placeholder="WIF (cXyz...) or hex (64 chars)"
                    value={encryptionKeyInput}
                    onChange={(e) => {
                      setEncryptionKeyInput(e.target.value)
                      setKeyError(null)
                    }}
                    className="font-mono text-sm"
                  />
                  {keyError && (
                    <p className="text-sm text-red-600 dark:text-red-400">
                      {keyError}
                    </p>
                  )}
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={handleCancelEnable}
                    disabled={isEnabling}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleEnablePrivateFeed}
                    disabled={isEnabling || !encryptionKeyInput.trim()}
                  >
                    {isEnabling ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Enabling...
                      </>
                    ) : (
                      <>
                        <LockClosedIcon className="h-4 w-4 mr-2" />
                        Enable
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}

            <div className="pt-4 border-t">
              <h4 className="font-medium mb-2 text-sm">How it works:</h4>
              <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <li className="flex gap-2">
                  <span className="text-yappr-500">•</span>
                  Your private posts are encrypted with a unique feed key
                </li>
                <li className="flex gap-2">
                  <span className="text-yappr-500">•</span>
                  Only approved followers can decrypt and view your private posts
                </li>
                <li className="flex gap-2">
                  <span className="text-yappr-500">•</span>
                  Revoked followers lose access to new private posts
                </li>
                <li className="flex gap-2">
                  <span className="text-yappr-500">•</span>
                  Your encryption key is needed to manage your private feed
                </li>
              </ul>
            </div>
          </>
        )}

        {/* Add Encryption Key Modal */}
        <AddEncryptionKeyModal
          isOpen={showAddKeyModal}
          onClose={() => setShowAddKeyModal(false)}
          onSuccess={() => {
            setShowAddKeyModal(false)
            setHasEncryptionKeyOnIdentity(true)
            checkPrivateFeedStatus().catch(err => logger.error('Failed to recheck status:', err))
          }}
        />
      </CardContent>
    </Card>
  )
}
