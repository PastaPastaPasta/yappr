'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import type { PostVisibility } from '@/lib/store'
import type { AuthUser } from '@/contexts/auth-context'

/**
 * Whether the composer may post privately, and the flow that turns a private
 * feed on when the author picks a private visibility without one: add an
 * encryption key to the identity if it has none, enter the key, enable the
 * feed, then apply the visibility they asked for.
 */
export function useComposePrivateFeed(isOpen: boolean, user: AuthUser | null, applyVisibility: (v: PostVisibility) => void) {
  const [hasPrivateFeed, setHasPrivateFeed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [followerCount, setFollowerCount] = useState(0)
  const [hasEncryptionKeyOnIdentity, setHasEncryptionKeyOnIdentity] = useState(false)
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [pendingVisibility, setPendingVisibility] = useState<PostVisibility | null>(null)

  useEffect(() => {
    if (!isOpen) return
    if (!user) {
      setLoading(false)
      return
    }
    setLoading(true)
    const check = async () => {
      try {
        const { privateFeedService, privateFeedKeyStore, identityService } = await import('@/lib/services')
        // Local keys are proof enough; only ask Platform when there are none.
        const hasPrivate = privateFeedKeyStore.hasFeedSeed() || (await privateFeedService.hasPrivateFeed(user.identityId))
        setHasPrivateFeed(hasPrivate)
        setFollowerCount(hasPrivate ? Object.keys(privateFeedKeyStore.getRecipientMap()).length : 0)
        if (!hasPrivate) {
          try {
            const { hasEncryptionKeyOnIdentity } = await import('@/lib/crypto/encryption-key-lookup')
            const identity = await identityService.getIdentity(user.identityId)
            setHasEncryptionKeyOnIdentity(identity?.publicKeys ? hasEncryptionKeyOnIdentity(identity.publicKeys) : false)
          } catch {
            setHasEncryptionKeyOnIdentity(false)
          }
        }
      } catch (error) {
        logger.error('Failed to check private feed status:', error)
        setHasPrivateFeed(false)
      } finally {
        setLoading(false)
      }
    }
    check().catch((err) => logger.error('Failed to check private feed:', err))
  }, [isOpen, user])

  const enableAfterKeyEntry = useCallback(
    async (targetVisibility: PostVisibility) => {
      if (!user) return
      try {
        const { privateFeedService, privateFeedKeyStore } = await import('@/lib/services')
        const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
        const encryptionPrivateKey = getEncryptionKeyBytes(user.identityId)
        if (!encryptionPrivateKey) {
          toast.error('No encryption key found. Please try again.')
          return
        }
        const result = await privateFeedService.enablePrivateFeed(user.identityId, encryptionPrivateKey)
        if (!result.success) {
          toast.error(result.error || 'Failed to enable private feed')
          return
        }
        setHasPrivateFeed(true)
        applyVisibility(targetVisibility)
        toast.success('Private feed enabled!')
        setFollowerCount(Object.keys(privateFeedKeyStore.getRecipientMap()).length)
      } catch (error) {
        logger.error('Error enabling private feed:', error)
        toast.error('Failed to enable private feed')
      } finally {
        setPendingVisibility(null)
      }
    },
    [user, applyVisibility]
  )

  const requestEnable = useCallback(
    async (targetVisibility: PostVisibility) => {
      if (!user) return
      setPendingVisibility(targetVisibility)
      if (!hasEncryptionKeyOnIdentity) {
        setShowAddKeyModal(true)
        return
      }
      const { useEncryptionKeyModal } = await import('@/hooks/use-encryption-key-modal')
      useEncryptionKeyModal.getState().open('manage_private_feed', () => enableAfterKeyEntry(targetVisibility))
    },
    [user, hasEncryptionKeyOnIdentity, enableAfterKeyEntry]
  )

  const onKeyAdded = useCallback(async () => {
    setShowAddKeyModal(false)
    setHasEncryptionKeyOnIdentity(true)
    if (pendingVisibility) await enableAfterKeyEntry(pendingVisibility)
  }, [pendingVisibility, enableAfterKeyEntry])

  const cancelAddKey = useCallback(() => {
    setShowAddKeyModal(false)
    setPendingVisibility(null)
  }, [])

  return { hasPrivateFeed, loading, followerCount, requestEnable, showAddKeyModal, onKeyAdded, cancelAddKey }
}
