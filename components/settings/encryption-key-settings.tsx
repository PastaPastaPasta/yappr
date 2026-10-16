'use client'

import { logger } from '@/lib/logger'
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { getEncryptionKey } from '@/lib/secure-storage'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { KeyIcon, LockClosedIcon, PlusIcon } from '@heroicons/react/24/outline'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { identityService } from '@/lib/services/identity-service'

/** The key row's right-hand side: the stored key, or the way to enter or create one. */
function EncryptionKeyStatus({ hasKey, hasKeyOnIdentity, onEnter, onSetUp }: {
  hasKey: boolean
  hasKeyOnIdentity: boolean | null
  onEnter: () => void
  onSetUp: () => void
}) {
  if (hasKey) {
    return (
      <span className="text-xs px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded">
        On this device
      </span>
    )
  }
  if (hasKeyOnIdentity === null) return <span className="text-xs text-gray-500">Checking…</span>
  // On the identity already: enter it here. Otherwise: create one.
  const [Icon, label, onClick] = hasKeyOnIdentity ? [KeyIcon, 'Enter Key', onEnter] : [PlusIcon, 'Set Up', onSetUp]
  return (
    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClick}>
      <Icon className="h-3 w-3 mr-1" />
      {label}
    </Button>
  )
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
  const [hasKey, setHasKey] = useState(false)
  const [hasKeyOnIdentity, setHasKeyOnIdentity] = useState<boolean | null>(null)

  const refreshEncryptionKeyInfo = useCallback(() => {
    setHasKey(user ? getEncryptionKey(user.identityId) !== null : false)
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
    identityService.hasEncryptionKey(identityId)
      .then((onChain) => {
        if (!cancelled) setHasKeyOnIdentity(onChain)
      })
      .catch((err) => {
        logger.error('Error checking on-chain encryption key status:', err)
        // Set Up re-checks the identity before it adds anything.
        if (!cancelled) setHasKeyOnIdentity(false)
      })
    return () => {
      cancelled = true
    }
  }, [identityId, hasKey])

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
            <EncryptionKeyStatus
              hasKey={hasKey}
              hasKeyOnIdentity={hasKeyOnIdentity}
              onEnter={() => openEncryptionKeyModal('generic', handleEncryptionKeyChanged)}
              onSetUp={() => setShowAddKeyModal(true)}
            />
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
