'use client'

import { logger } from '@/lib/logger'
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { getEncryptionKey, getEncryptionKeyType, type KeyType } from '@/lib/secure-storage'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { KeyIcon, LockClosedIcon, PlusIcon } from '@heroicons/react/24/outline'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'

interface KeyInfo {
  hasKey: boolean
  type: KeyType | null
}

interface EncryptionKeySettingsProps {
  onEncryptionKeyChanged?: () => void
}

/**
 * The encryption key of a private-key sign-in: whether this browser holds
 * it, and the way to enter or set it up. It is what messages, private feeds
 * and store orders are encrypted with. (A wallet sign-in manages its keys in
 * the wallet instead: see WalletConnectionsSettings.)
 */
export function EncryptionKeySettings({ onEncryptionKeyChanged }: EncryptionKeySettingsProps) {
  const { user } = useAuth()
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [encryptionKeyInfo, setEncryptionKeyInfo] = useState<KeyInfo>({ hasKey: false, type: null })
  const [hasKeyOnIdentity, setHasKeyOnIdentity] = useState<boolean | null>(null)

  const refreshEncryptionKeyInfo = useCallback(() => {
    if (!user) {
      setEncryptionKeyInfo({ hasKey: false, type: null })
      return
    }
    setEncryptionKeyInfo({ hasKey: getEncryptionKey(user.identityId) !== null, type: getEncryptionKeyType(user.identityId) })
  }, [user])

  useEffect(() => {
    refreshEncryptionKeyInfo()
  }, [refreshEncryptionKeyInfo])

  // Whether the identity has an encryption key on chain decides between "Enter Key" and "Set Up".
  const identityId = user?.identityId
  useEffect(() => {
    if (!identityId) return
    let cancelled = false
    setHasKeyOnIdentity(null)
    import('@/lib/services/identity-service')
      .then(({ identityService }) => identityService.hasEncryptionKey(identityId))
      .then((onChain) => {
        if (!cancelled) setHasKeyOnIdentity(onChain)
      })
      .catch((err) => logger.error('Error checking on-chain encryption key status:', err))
    return () => {
      cancelled = true
    }
  }, [identityId, encryptionKeyInfo.hasKey])

  const handleEncryptionKeyChanged = useCallback(() => {
    refreshEncryptionKeyInfo()
    onEncryptionKeyChanged?.()
  }, [onEncryptionKeyChanged, refreshEncryptionKeyInfo])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LockClosedIcon className="h-5 w-5" />
          Encryption key
        </CardTitle>
        <CardDescription>
          Messages, private feeds and store orders are encrypted with this key.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
          <div className="flex items-center gap-2">
            <LockClosedIcon className="h-4 w-4 text-gray-500" />
            <span className="text-sm">Encryption Key</span>
          </div>
          <div className="flex items-center gap-2">
            {encryptionKeyInfo.hasKey ? (
              <>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  encryptionKeyInfo.type === 'derived'
                    ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                    : 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300'
                }`}>
                  {encryptionKeyInfo.type === 'derived' ? 'Derived' : 'External'}
                </span>
                <span className="text-xs px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded">
                  Active
                </span>
              </>
            ) : hasKeyOnIdentity === null ? (
              <span className="text-xs text-gray-500">Checking…</span>
            ) : hasKeyOnIdentity ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => openEncryptionKeyModal('generic', handleEncryptionKeyChanged)}
              >
                <KeyIcon className="h-3 w-3 mr-1" />
                Enter Key
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowAddKeyModal(true)}
              >
                <PlusIcon className="h-3 w-3 mr-1" />
                Set Up
              </Button>
            )}
          </div>
        </div>
      </CardContent>

      <AddEncryptionKeyModal
        isOpen={showAddKeyModal}
        onClose={() => setShowAddKeyModal(false)}
        onSuccess={() => {
          setShowAddKeyModal(false)
          handleEncryptionKeyChanged()
        }}
        context="generic"
      />
    </Card>
  )
}
