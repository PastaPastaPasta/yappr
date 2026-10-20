'use client'

import { logger } from '@/lib/logger';
import { useId, useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { usePrivateFeedRefreshStore } from '@/lib/stores/private-feed-refresh-store'
import { withoutRevokedGrants } from '@/lib/utils/revoked-grants'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LockClosedIcon, CheckCircleIcon, UserGroupIcon, ExclamationTriangleIcon, KeyIcon, PlusIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { usePrivateFeedMove } from '@/hooks/use-private-feed-move'
import { RenewPrivateFeedDialog } from './renew-private-feed-dialog'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { useWalletSession } from '@/components/auth/wallet-encryption-key-prompt'

interface PrivateFeedSettingsProps {
  /** If true, automatically open the renewal dialog when component mounts (the lost-key flow) */
  openRenew?: boolean
  /** Callback when the renewal dialog is opened (for clearing URL params) */
  onRenewOpened?: () => void
}

/** The current feed's stored caps and use, as Settings shows them. */
interface FeedStats {
  followerCount: number
  treeCapacity: number
  keyGeneration: number
  maxKeyGeneration: number
  keyRotated: boolean
}

/** A feed is nearly full at 90% of its leaves or within 10 key changes of its cap (design §7.7). */
function nearlyFull(stats: FeedStats): boolean {
  return stats.followerCount >= 0.9 * stats.treeCapacity || stats.keyGeneration >= stats.maxKeyGeneration - 10
}

/** Why the renewal dialog is opened, from the feed's state. */
function renewReason(stats: FeedStats | null): 'choice' | 'key-changed' | 'full' {
  if (stats?.keyRotated) return 'key-changed'
  if (stats && nearlyFull(stats)) return 'full'
  return 'choice'
}

/**
 * Keep the key the chain just accepted available the way the manual key-entry
 * flow does. Throws when it cannot be saved (the store swallows write failures,
 * so this reads it back).
 */
async function rememberEncryptionKey(identityId: string, enteredKey: string, acceptedKey: Uint8Array): Promise<void> {
  const {
    storeEncryptionKey,
    getEncryptionKey,
    getEncryptionKeyBytes,
    clearEncryptionKey,
    storeEncryptionKeyType,
    clearEncryptionKeyType,
  } = await import('@/lib/secure-storage')
  const { bytesEqual } = await import('@/lib/bytes')
  // The input is prefilled with the stored key, which may be a derived key.
  // Remember it so resubmitting that same key does not relabel it.
  const priorKeyBytes = getEncryptionKeyBytes(identityId)
  storeEncryptionKey(identityId, enteredKey)
  const normalizedEncryptionKey = getEncryptionKey(identityId)
  // The store swallows write failures, so a non-null readback can still be a stale
  // key left over from an earlier session. Compare the decoded secret with the key
  // that was actually accepted before backing anything up.
  const storedKeyBytes = getEncryptionKeyBytes(identityId)
  if (!normalizedEncryptionKey || !storedKeyBytes || !bytesEqual(storedKeyBytes, acceptedKey)) {
    // Drop any stale key so later private-feed operations cannot pick up a secret
    // that no longer matches the one the chain just accepted.
    clearEncryptionKey(identityId)
    clearEncryptionKeyType(identityId)
    throw new Error('Encryption key was not saved')
  }
  // A newly pasted key is recorded as external, matching the add-encryption-key flow.
  // Resubmitting the key that was already stored keeps its existing type label.
  if (!priorKeyBytes || !bytesEqual(priorKeyBytes, acceptedKey)) {
    storeEncryptionKeyType(identityId, 'external')
  }
}

function BulletList({ items }: { items: readonly string[] }) {
  return (
    <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span className="text-yappr-500">•</span>
          {item}
        </li>
      ))}
    </ul>
  )
}

/** The amber "encryption key required" box. */
function EncryptionKeyRequiredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
      <div className="flex gap-3">
        <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
            Encryption key required
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {children}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * PrivateFeedSettings Component
 *
 * Settings section for managing private feeds.
 * Implements PRD §4.1 - Enable Private Feed UI
 */
export function PrivateFeedSettings({ openRenew = false, onRenewOpened }: PrivateFeedSettingsProps) {
  const encryptionKeyId = useId()
  const { user } = useAuth()
  // A wallet sign-in's messaging key lives in its key ring; nothing here stores or backs it up.
  const walletSession = useWalletSession()
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const refreshKey = usePrivateFeedRefreshStore((state) => state.refreshKey)
  const triggerRefresh = usePrivateFeedRefreshStore((state) => state.triggerRefresh)
  const [isEnabled, setIsEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isEnabling, setIsEnabling] = useState(false)
  const [enabledDate, setEnabledDate] = useState<Date | null>(null)
  const [stats, setStats] = useState<FeedStats | null>(null)
  const [hasEncryptionKeyStored, setHasEncryptionKeyStored] = useState(false)
  const [isRenewing, setIsRenewing] = useState(false)
  const move = usePrivateFeedMove(user?.identityId)

  // Encryption key input state
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [encryptionKeyInput, setEncryptionKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)

  // Renewal dialog state
  const [showRenewDialog, setShowRenewDialog] = useState(false)

  // Add encryption key modal state
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [hasEncryptionKeyOnIdentity, setHasEncryptionKeyOnIdentity] = useState<boolean | null>(null)

  const checkPrivateFeedStatus = useCallback(async () => {
    if (!user) {
      setIsLoading(false)
      return
    }

    try {
      const { privateFeedService } = await import('@/lib/services')
      const { hasEncryptionKey } = await import('@/lib/secure-storage')
      const { identityService } = await import('@/lib/services/identity-service')

      const overview = await privateFeedService.getOverview(user.identityId)
      const hasPrivateFeed = overview !== null
      setIsEnabled(hasPrivateFeed)

      // Check if encryption key is stored in session
      setHasEncryptionKeyStored(hasEncryptionKey(user.identityId))

      // Check if user has encryption key on identity (only if not already enabled)
      if (!overview) {
        const hasKeyOnIdentity = await identityService.hasEncryptionKey(user.identityId)
        setHasEncryptionKeyOnIdentity(hasKeyOnIdentity)
        return
      }

      // "On since" the first feed; the stats and caps are the current feed's own (R-M30).
      setEnabledDate(new Date(overview.feeds[overview.feeds.length - 1].createdAt))
      setStats({
        followerCount: withoutRevokedGrants(overview.followers, usePrivateFeedRefreshStore.getState().revokedGrantsFor(user.identityId)).length,
        treeCapacity: overview.feed.treeCapacity,
        keyGeneration: overview.keyGeneration,
        maxKeyGeneration: overview.feed.maxKeyGeneration,
        keyRotated: overview.keyRotated,
      })
      // A move no device finished (a crash before it was saved, or begun elsewhere) resumes here.
      const { adoptUnfinishedMove } = await import('@/lib/services/private-feed-move')
      await adoptUnfinishedMove(user.identityId)
    } catch (error) {
      logger.error('Error checking private feed status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  useEffect(() => {
    checkPrivateFeedStatus().catch(err => logger.error('Failed to check private feed status:', err))
  }, [checkPrivateFeedStatus, refreshKey])

  // Open the renewal dialog when directed from the lost-key flow
  useEffect(() => {
    if (openRenew && isEnabled && !isLoading) {
      setShowRenewDialog(true)
      // Notify parent to clear URL param to prevent dialog re-opening
      onRenewOpened?.()
    }
  }, [openRenew, isEnabled, isLoading, onRenewOpened])

  /** Renew, or continue a paused move; both need the encryption key in this session. */
  const withEncryptionKey = async (action: (key: Uint8Array) => Promise<void>) => {
    if (!user) return
    const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
    const key = getEncryptionKeyBytes(user.identityId)
    if (key) {
      await action(key)
      return
    }
    openEncryptionKeyModal('manage_private_feed', () => {
      const entered = getEncryptionKeyBytes(user.identityId)
      if (entered) action(entered).catch((error) => logger.error('Private feed action failed:', error))
    })
  }

  const handleRenew = (bringHistory: boolean) => {
    setShowRenewDialog(false)
    withEncryptionKey(async (key) => {
      if (!user) return
      setIsRenewing(true)
      try {
        const { renewPrivateFeed } = await import('@/lib/services/private-feed-move')
        const result = await renewPrivateFeed(user.identityId, key, { bringHistory })
        if (result.success) {
          toast.success(result.historyLinked === false && bringHistory
            ? 'Private feed renewed. Posts from before this change stay visible only to people who already follow you.'
            : 'Private feed renewed')
        } else if (result.error) {
          toast.error(result.error)
        }
      } finally {
        setIsRenewing(false)
        triggerRefresh()
      }
    }).catch((error) => logger.error('Renewal failed:', error))
  }

  const handleContinueMove = () => {
    withEncryptionKey(async (key) => {
      if (!user) return
      const { runMove } = await import('@/lib/services/private-feed-move')
      const result = await runMove(user.identityId, key)
      if (!result.success && result.error) toast.error(result.error)
      triggerRefresh()
    }).catch((error) => logger.error('Continuing the move failed:', error))
  }

  const handleStartEnable = async () => {
    // Check if we already have the key stored in secure storage
    if (user) {
      const { getEncryptionKey } = await import('@/lib/secure-storage')
      const storedKey = getEncryptionKey(user.identityId)
      // A wallet sign-in uses the messaging key its wallet granted, never a typed one.
      if (walletSession && !storedKey) {
        openEncryptionKeyModal('manage_private_feed', checkPrivateFeedStatus)
        return
      }
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
        if (!walletSession) {
          try {
            await rememberEncryptionKey(user.identityId, trimmedKey, validation.privateKey)
          } catch (error) {
            logger.error('Failed to store encryption key after enabling private feed:', error)
            toast.error('Private feed enabled, but your key could not be saved. Enter it again to manage your feed.')
          }
        }
        // Refresh this card's status and the sibling requests, followers and
        // dashboard cards, which still read "disabled". This card re-reads its
        // status from the refresh key, so it is not checked again here.
        triggerRefresh()
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

            {move && (
              <div data-testid="private-feed-move" className={move.job.error ? 'bg-amber-50 dark:bg-amber-950 p-4 rounded-lg space-y-2' : 'bg-blue-50 dark:bg-blue-950 p-4 rounded-lg space-y-2'}>
                <p className="text-sm font-medium">
                  Moving followers: {move.done.toLocaleString()} of {move.total.toLocaleString()}
                </p>
                <div className="h-2 bg-white/60 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-yappr-500 transition-all" style={{ width: `${move.total ? Math.round((move.done / move.total) * 100) : 100}%` }} />
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {move.job.error ?? 'Private posting pauses until everyone has been moved.'}
                </p>
                {(move.job.error || move.done >= move.total) && (
                  <Button size="sm" variant="outline" onClick={handleContinueMove}>Continue</Button>
                )}
              </div>
            )}

            {stats && !move && (stats.keyRotated || nearlyFull(stats)) && (
              <div data-testid="private-feed-renew-prompt" className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
                <div className="flex gap-3">
                  <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      {stats.keyRotated ? 'Your messaging key changed' : 'Your private feed is nearly full'}
                    </p>
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      {stats.keyRotated
                        ? 'Renew your private feed so it uses your new key. Your followers are moved over automatically.'
                        : 'Renew it to make room. Your followers are moved over automatically.'}
                    </p>
                    <Button size="sm" onClick={() => setShowRenewDialog(true)} disabled={isRenewing}>Renew private feed</Button>
                  </div>
                </div>
              </div>
            )}

            {stats && (
              <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <UserGroupIcon className="h-4 w-4" aria-hidden="true" />
                {stats.followerCount.toLocaleString()} private {stats.followerCount === 1 ? 'follower' : 'followers'}
              </p>
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

            {/* Renewal (design §7.4–§7.7): new keys, followers moved automatically */}
            <div className="pt-4 border-t">
              <h4 className="font-medium mb-2 text-sm flex items-center gap-2">
                <ArrowPathIcon className="h-4 w-4" />
                Renew
              </h4>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Start your private feed over if you think your key was exposed. Your private followers move over automatically.
              </p>
              <Button
                data-testid="renew-private-feed-btn"
                variant="outline"
                className="mt-3"
                onClick={() => setShowRenewDialog(true)}
                disabled={isRenewing || !!move}
              >
                {isRenewing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Renewing...</> : 'Renew private feed'}
              </Button>
            </div>

            {user && (
              <RenewPrivateFeedDialog
                open={showRenewDialog}
                onOpenChange={setShowRenewDialog}
                ownerId={user.identityId}
                reason={renewReason(stats)}
                onConfirm={handleRenew}
              />
            )}
          </>
        ) : (
          <>
            {!showKeyInput ? (
              <>
                {/* Show different UI based on whether user has encryption key on identity */}
                {hasEncryptionKeyOnIdentity === false ? (
                  <div className="space-y-3">
                    <EncryptionKeyRequiredNotice>
                      To use private feeds, you need to add an encryption key to your identity first.
                    </EncryptionKeyRequiredNotice>
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
                {!walletSession && (
                  <EncryptionKeyRequiredNotice>
                    Enter your identity encryption private key (WIF or hex format).
                    This key is used to encrypt and decrypt your private feed data.
                  </EncryptionKeyRequiredNotice>
                )}

                <div className="space-y-2">
                  {walletSession ? (
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Your private feed will use the messaging key from your Dash wallet.
                    </p>
                  ) : (
                    <>
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
                    </>
                  )}
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
              <h4 className="font-medium mb-2 text-sm">How it works</h4>
              <BulletList items={[
                'Only followers you approve can read your private posts',
                'Remove someone at any time: they lose access to new private posts',
                'Images aren\'t private: anyone with an image\'s link can see it',
                'If someone reports a private post, moderators can read it and earlier posts in your private feed',
              ]} />
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
