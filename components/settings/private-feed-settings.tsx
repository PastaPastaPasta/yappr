'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LockClosedIcon, CheckCircleIcon, UserGroupIcon, ExclamationTriangleIcon, KeyIcon, ArrowPathIcon, PlusIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { TREE_CAPACITY, MAX_EPOCH } from '@/lib/services'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { ResetPrivateFeedDialog } from './reset-private-feed-dialog'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'

interface PrivateFeedSettingsProps {
  /** If true, automatically open the reset dialog when component mounts */
  openReset?: boolean
}

/**
 * PrivateFeedSettings Component
 *
 * Settings section for managing private feeds.
 * Implements PRD §4.1 - Enable Private Feed UI
 */
export function PrivateFeedSettings({ openReset = false }: PrivateFeedSettingsProps) {
  const { user } = useAuth()
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const [isEnabled, setIsEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isEnabling, setIsEnabling] = useState(false)
  const [enabledDate, setEnabledDate] = useState<Date | null>(null)
  const [followerCount, setFollowerCount] = useState(0)
  const [currentEpoch, setCurrentEpoch] = useState(1)
  const [hasEncryptionKeyStored, setHasEncryptionKeyStored] = useState(false)

  // Encryption key input state
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [encryptionKeyHex, setEncryptionKeyHex] = useState('')
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
      const hasPrivateFeed = await privateFeedService.hasPrivateFeed(user.identityId)
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
        const state = await privateFeedService.getPrivateFeedState(user.identityId)
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
          console.error('Failed to get followers from chain, using local state:', err)
          // Fallback to local storage if on-chain query fails
          if (privateFeedKeyStore.hasFeedSeed()) {
            const recipientMap = privateFeedKeyStore.getRecipientMap()
            setFollowerCount(Object.keys(recipientMap || {}).length)
          }
        }
      }
    } catch (error) {
      console.error('Error checking private feed status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  useEffect(() => {
    checkPrivateFeedStatus().catch(err => console.error('Failed to check private feed status:', err))
  }, [checkPrivateFeedStatus])

  // Handle openReset prop - open reset dialog when directed from lost key flow
  useEffect(() => {
    if (openReset && isEnabled && !isLoading) {
      setShowResetDialog(true)
    }
  }, [openReset, isEnabled, isLoading])

  const handleStartEnable = async () => {
    // Check if we already have the key stored in secure storage
    if (user) {
      const { getEncryptionKey } = await import('@/lib/secure-storage')
      const storedKey = getEncryptionKey(user.identityId)
      if (storedKey) {
        // Pre-populate the key field with the stored key
        setEncryptionKeyHex(storedKey)
      }
    }
    setShowKeyInput(true)
    setKeyError(null)
  }

  const handleCancelEnable = () => {
    setShowKeyInput(false)
    setEncryptionKeyHex('')
    setKeyError(null)
  }

  const validateAndParseKey = (hexKey: string): Uint8Array | null => {
    // Remove 0x prefix if present
    let cleanHex = hexKey.trim()
    if (cleanHex.startsWith('0x')) {
      cleanHex = cleanHex.slice(2)
    }

    // Check length (32 bytes = 64 hex chars)
    if (cleanHex.length !== 64) {
      setKeyError(`Key must be 64 hex characters (32 bytes), got ${cleanHex.length}`)
      return null
    }

    // Check valid hex
    if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
      setKeyError('Key must contain only hexadecimal characters (0-9, a-f)')
      return null
    }

    // Parse to Uint8Array
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16)
    }

    return bytes
  }

  const handleEnablePrivateFeed = async () => {
    if (!user) return

    const encryptionKey = validateAndParseKey(encryptionKeyHex)
    if (!encryptionKey) return

    setIsEnabling(true)
    setKeyError(null)

    try {
      const { privateFeedService, privateFeedCryptoService } = await import('@/lib/services')

      // Verify the key by deriving its public key
      try {
        privateFeedCryptoService.getPublicKey(encryptionKey)
      } catch {
        setKeyError('Invalid private key format')
        setIsEnabling(false)
        return
      }

      // Enable private feed
      const result = await privateFeedService.enablePrivateFeed(user.identityId, encryptionKey)

      if (result.success) {
        toast.success('Private feed enabled successfully!')
        setIsEnabled(true)
        setEnabledDate(new Date())
        setShowKeyInput(false)
        setEncryptionKeyHex('')
      } else {
        setKeyError(result.error || 'Failed to enable private feed')
        toast.error(result.error || 'Failed to enable private feed')
      }
    } catch (error) {
      console.error('Error enabling private feed:', error)
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

            {/* Reset Private Feed Section */}
            <div className="pt-4 border-t">
              <h4 className="font-medium mb-2 text-sm flex items-center gap-2 text-red-600 dark:text-red-400">
                <ExclamationTriangleIcon className="h-4 w-4" />
                Danger Zone
              </h4>
              <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-4 rounded-lg">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-red-900 dark:text-red-100">
                    Reset Private Feed
                  </p>
                  <p className="text-sm text-red-700 dark:text-red-300">
                    If you have lost your encryption key or want to start fresh, you can reset your private feed.
                    This will remove all current followers and make existing private posts unreadable.
                  </p>
                  <Button
                    data-testid="reset-private-feed-btn"
                    variant="outline"
                    className="mt-2 border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900"
                    onClick={() => setShowResetDialog(true)}
                  >
                    <ArrowPathIcon className="h-4 w-4 mr-2" />
                    Reset Private Feed
                  </Button>
                </div>
              </div>
            </div>

            {/* Reset Dialog */}
            <ResetPrivateFeedDialog
              open={showResetDialog}
              onOpenChange={setShowResetDialog}
              onSuccess={checkPrivateFeedStatus}
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
                        Enter your identity encryption private key (32 bytes in hex format).
                        This key is used to encrypt and decrypt your private feed data.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Encryption Private Key (hex)
                  </label>
                  <Input
                    type="password"
                    placeholder="Enter 64 hex characters (e.g., 0xabc123...)"
                    value={encryptionKeyHex}
                    onChange={(e) => {
                      setEncryptionKeyHex(e.target.value)
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
                    disabled={isEnabling || !encryptionKeyHex.trim()}
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
            checkPrivateFeedStatus().catch(err => console.error('Failed to recheck status:', err))
          }}
        />
      </CardContent>
    </Card>
  )
}
