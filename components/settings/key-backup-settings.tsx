'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { vaultService } from '@/lib/services/vault-service'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'
import { authVaultService } from '@/lib/services/auth-vault-service'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'
import {
  getEncryptionKey,
  getEncryptionKeyType,
  type KeyType
} from '@/lib/secure-storage'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CloudArrowUpIcon, TrashIcon, ShieldCheckIcon, CheckCircleIcon, KeyIcon, LockClosedIcon, PlusIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { AddEncryptionKeyModal } from '@/components/auth/add-encryption-key-modal'
import { useEncryptionKeyModal } from '@/hooks/use-encryption-key-modal'
import { getPasskeyPrfSupport } from '@/lib/webauthn/passkey-support'

interface KeyInfo {
  hasKey: boolean
  type: KeyType | null
}

export function KeyBackupSettings() {
  const { user, addPasskeyWrapper } = useAuth()
  const { open: openEncryptionKeyModal } = useEncryptionKeyModal()
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasBackup, setHasBackup] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isDeleting, setIsDeleting] = useState(false)
  const [backupDate, setBackupDate] = useState<Date | null>(null)
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [encryptionKeyInfo, setEncryptionKeyInfo] = useState<KeyInfo>({ hasKey: false, type: null })
  const [hasKeyOnIdentity, setHasKeyOnIdentity] = useState<boolean | null>(null)
  const [canEnrollPasskey, setCanEnrollPasskey] = useState(false)
  const [isAddingPasskey, setIsAddingPasskey] = useState(false)
  const [passkeySupportMessage, setPasskeySupportMessage] = useState<string | null>(null)
  const [passkeyCount, setPasskeyCount] = useState(0)
  const [secretKind, setSecretKind] = useState<'login-key' | 'auth-key' | null>(null)
  const [hasVaultEncryptionKey, setHasVaultEncryptionKey] = useState<boolean | null>(null)
  const [hasVaultTransferKey, setHasVaultTransferKey] = useState<boolean | null>(null)
  const [vaultLockedLocally, setVaultLockedLocally] = useState(false)
  // Run token: ensures only the latest invocation of checkBackupStatus updates state
  const latestRunIdRef = useRef(0)
  const hasActiveVaultAccess = hasBackup || passkeyCount > 0
  const unlockMethodCount = (hasBackup ? 1 : 0) + Math.min(1, passkeyCount)

  const refreshEncryptionKeyInfo = useCallback(() => {
    if (!user) {
      setEncryptionKeyInfo({ hasKey: false, type: null })
      return
    }
    const key = getEncryptionKey(user.identityId)
    const type = getEncryptionKeyType(user.identityId)
    setEncryptionKeyInfo({ hasKey: !!key, type })
  }, [user])

  useEffect(() => {
    refreshEncryptionKeyInfo()
  }, [refreshEncryptionKeyInfo])

  useEffect(() => {
    getPasskeyPrfSupport()
      .then((support) => {
        setCanEnrollPasskey(support.webauthnAvailable && support.likelyPrfCapable)
        setPasskeySupportMessage(support.blockedReason ?? null)
      })
      .catch(() => {
        setCanEnrollPasskey(false)
        setPasskeySupportMessage('Passkey enrollment requires a PRF-capable browser and passkey provider.')
      })
  }, [])

  const checkBackupStatus = useCallback(async () => {
    if (!user) {
      setIsLoading(false)
      return
    }

    const runId = ++latestRunIdRef.current

    try {
      const authVaultConfigured = authVaultService.isConfigured()
      const vaultConfigured = vaultService.isConfigured()
      const oldConfigured = encryptedKeyService.isConfigured()
      const configured = authVaultConfigured || vaultConfigured || oldConfigured
      if (runId !== latestRunIdRef.current) return
      setIsConfigured(configured)

      if (configured) {
        // Reset backup state to avoid showing stale values
        setHasBackup(false)
        setBackupDate(null)
        setPasskeyCount(0)
        setSecretKind(null)
        setHasVaultEncryptionKey(null)
        setHasVaultTransferKey(null)
        setVaultLockedLocally(false)

        try {
          let foundBackup = false

          if (authVaultConfigured) {
            const status = await authVaultService.getStatus(user.identityId)
            if (runId !== latestRunIdRef.current) return
            setHasBackup(status.hasPasswordAccess)
            setPasskeyCount(status.passkeyCount)
            setSecretKind(status.secretKind ?? null)
            foundBackup = status.hasPasswordAccess || status.passkeyCount > 0

            const dek = (await import('@/lib/secure-storage')).getAuthVaultDekBytes(user.identityId)
            if (status.hasVault && !dek) {
              setVaultLockedLocally(true)
            } else if (dek && status.hasVault) {
              const unlocked = await authVaultService.decryptVault(user.identityId, dek).catch(() => null)
              if (runId !== latestRunIdRef.current) return
              if (unlocked) {
                setHasVaultEncryptionKey(Boolean(unlocked.bundle.encryptionKeyWif))
                setHasVaultTransferKey(Boolean(unlocked.bundle.transferKeyWif))
              } else {
                setVaultLockedLocally(true)
              }
            }
          }

          // Check legacy vault contract next
          if (!foundBackup && vaultConfigured) {
            const hasVaultBackup = await vaultService.hasPasswordBackup(user.identityId)
            if (runId !== latestRunIdRef.current) return
            if (hasVaultBackup) {
              setHasBackup(true)
              foundBackup = true
              // Vault documents don't have $createdAt exposed the same way, skip date
            }
          }
          // Fall back to old contract
          if (!foundBackup && oldConfigured) {
            const backup = await encryptedKeyService.getBackupByIdentityId(user.identityId)
            if (runId !== latestRunIdRef.current) return
            setHasBackup(!!backup)
            if (backup) {
              setBackupDate(new Date(backup.$createdAt))
            }
          }
        } catch (err) {
          logger.error('Error checking backup status:', err)
        }
      }
    } catch (error) {
      logger.error('Error checking backup configuration:', error)
    }

    // Check on-chain identity state for the encryption key (independent of session and backup)
    try {
      const { identityService } = await import('@/lib/services/identity-service')
      const onChain = await identityService.hasEncryptionKey(user.identityId)
      if (runId !== latestRunIdRef.current) return
      setHasKeyOnIdentity(onChain)
    } catch (err) {
      logger.error('Error checking on-chain encryption key status:', err)
    }

    if (runId !== latestRunIdRef.current) return
    setIsLoading(false)
  }, [user])

  useEffect(() => {
    checkBackupStatus().catch(err => logger.error('Failed to check backup status:', err))
  }, [checkBackupStatus])

  const vaultStatusBadgeClass = (stored: boolean | null): string => {
    if (stored === true) {
      return 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
    }
    if (stored === false) {
      return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
    }
    return 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300'
  }

  const vaultStatusLabel = (stored: boolean | null): string => {
    if (stored === true) return 'Stored in vault'
    if (stored === false) return 'Not in vault'
    return 'Vault locked on this device'
  }

  const handleCreateBackup = async () => {
    if (!user) return

    // Open the unified password wrapper modal
    const username = user.dpnsUsername || user.identityId
    useKeyBackupModal.getState().open(user.identityId, username, false)
  }

  const handleDeleteBackup = async () => {
    if (!user) return

    if (!confirm('Are you sure you want to delete your on-chain key backup? You will need to use your private key to log in.')) {
      return
    }

    setIsDeleting(true)
    try {
      const deletedBackends: string[] = []
      const failedBackends: string[] = []

      if (authVaultService.isConfigured()) {
        const authVaultDeleted = await authVaultService.deleteVault(user.identityId)
        if (authVaultDeleted) {
          deletedBackends.push('primary vault')
        } else {
          failedBackends.push('primary vault')
        }
      }
      if (vaultService.isConfigured()) {
        const vaultDeleted = await vaultService.deleteVault(user.identityId)
        if (vaultDeleted) {
          deletedBackends.push('legacy vault')
        } else {
          failedBackends.push('legacy vault')
        }
      }
      if (encryptedKeyService.isConfigured()) {
        const legacyDeleted = await encryptedKeyService.deleteBackup(user.identityId)
        if (legacyDeleted) {
          deletedBackends.push('legacy encrypted backup')
        } else {
          failedBackends.push('legacy encrypted backup')
        }
      }

      if (deletedBackends.length > 0) {
        await checkBackupStatus()
      }

      if (failedBackends.length === 0 && deletedBackends.length > 0) {
        toast.success('Backup deleted successfully')
      } else if (deletedBackends.length > 0) {
        toast.error(`${deletedBackends.join(', ')} deleted, but ${failedBackends.join(', ')} failed. Please retry.`)
      } else {
        toast.error('Failed to delete backup')
      }
    } catch (error) {
      logger.error('Error deleting backup:', error)
      toast.error('Failed to delete backup')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleAddPasskey = async () => {
    if (!user) return

    setIsAddingPasskey(true)
    try {
      await addPasskeyWrapper('Settings passkey')
      toast.success('Passkey added')
      await checkBackupStatus()
    } catch (error) {
      logger.error('Error adding passkey:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to add passkey')
    } finally {
      setIsAddingPasskey(false)
    }
  }

  // Re-check backup status when modal closes (in case a backup was created)
  useEffect(() => {
    const unsubscribe = useKeyBackupModal.subscribe((state, prevState) => {
      if (prevState.isOpen && !state.isOpen) {
        // Modal just closed, refresh backup status
        checkBackupStatus().catch(err => logger.error('Failed to check backup status:', err))
      }
    })
    return unsubscribe
  }, [checkBackupStatus])

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-gray-200 rounded w-3/4"></div>
            <div className="h-4 bg-gray-200 rounded w-1/2"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!isConfigured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudArrowUpIcon className="h-5 w-5" />
          Auth Vault
        </CardTitle>
        <CardDescription>
          Auth vault is not available
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-500">
          The auth vault feature is not yet configured for this network.
        </p>
      </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudArrowUpIcon className="h-5 w-5" />
          Auth Vault
        </CardTitle>
        <CardDescription>
          One encrypted bundle with password and passkey unlock methods
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Keys Status Section */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Keys Status</h4>
          <div className="space-y-2">
            {/* Canonical secret */}
            <div className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
              <div className="flex items-center gap-2">
                <KeyIcon className="h-4 w-4 text-gray-500" />
                <span className="text-sm">Canonical Secret</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded">
                  {secretKind === 'login-key' ? 'Wallet login secret' : 'Private key'}
                </span>
              </div>
            </div>

            {/* Encryption Key */}
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
                ) : hasKeyOnIdentity ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => openEncryptionKeyModal('generic', refreshEncryptionKeyInfo)}
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

            <div className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
              <div className="flex items-center gap-2">
                <LockClosedIcon className="h-4 w-4 text-gray-500" />
                <span className="text-sm">Transfer Key</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  vaultStatusBadgeClass(hasVaultTransferKey)
                }`}>
                  {vaultStatusLabel(hasVaultTransferKey)}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="h-4 w-4 text-gray-500" />
                <span className="text-sm">Passkeys</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  passkeyCount > 0
                    ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
                }`}>
                  {passkeyCount > 0 ? `${passkeyCount} active` : 'None'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {hasActiveVaultAccess ? (
          <>
            <div className="bg-green-50 dark:bg-green-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-green-900 dark:text-green-100">
                    {hasBackup ? 'Password unlock is active' : 'Passkey unlock is active'}
                  </p>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    {hasBackup
                      ? `Your auth vault can be unlocked with a password.${passkeyCount > 0 ? ` ${passkeyCount} passkey unlock method${passkeyCount === 1 ? '' : 's'} also active.` : ' Add a passkey for a stronger fallback.'}`
                      : `Your auth vault can be unlocked with ${passkeyCount} passkey unlock method${passkeyCount === 1 ? '' : 's'}. Add a password wrapper if you also want username + password recovery.`}
                    {backupDate && (
                      <span className="block mt-1 text-xs">
                        Created: {backupDate.toLocaleDateString()}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full text-red-600 hover:text-red-700 hover:border-red-300"
              onClick={handleDeleteBackup}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <TrashIcon className="h-4 w-4 mr-2" />
                  Delete Vault Access
                </>
              )}
            </Button>
          </>
        ) : (
          <>
            <div className="bg-orange-50 dark:bg-orange-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <ShieldCheckIcon className="h-5 w-5 text-orange-600 dark:text-orange-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-orange-900 dark:text-orange-100">
                    No password unlock found
                  </p>
                  <p className="text-sm text-orange-700 dark:text-orange-300">
                    Add a password wrapper so this auth vault can be unlocked with your username and password.
                  </p>
                </div>
              </div>
            </div>

            <Button
              className="w-full"
              onClick={handleCreateBackup}
            >
              <CloudArrowUpIcon className="h-4 w-4 mr-2" />
              Add Password Unlock
            </Button>
          </>
        )}

        <div className="space-y-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleAddPasskey}
            disabled={!canEnrollPasskey || isAddingPasskey}
          >
            {isAddingPasskey ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Adding passkey...
              </>
            ) : (
              'Add Passkey'
            )}
          </Button>
          {passkeySupportMessage && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {passkeySupportMessage}
            </p>
          )}
          {unlockMethodCount <= 1 && (
            <p className="text-xs text-orange-600 dark:text-orange-400">
              Keep at least two unlock methods if you want a realistic recovery path.
            </p>
          )}
          {hasVaultEncryptionKey && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Encryption key is already captured in the auth vault.
            </p>
          )}
          {vaultLockedLocally && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Vault key contents are hidden until this device unlocks the auth vault with an existing password or passkey.
            </p>
          )}
        </div>

        <div className="pt-4 border-t">
          <h4 className="font-medium mb-2">How it works:</h4>
          <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              One encrypted auth bundle is stored on Dash Platform
            </li>
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              Passwords and passkeys each wrap the same vault key instead of duplicating secrets
            </li>
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              Wallet QR users keep their wallet login secret as the canonical root material
            </li>
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              Yappr captures encryption and transfer keys into the same vault once they are learned
            </li>
          </ul>
        </div>
      </CardContent>

      <AddEncryptionKeyModal
        isOpen={showAddKeyModal}
        onClose={() => setShowAddKeyModal(false)}
        onSuccess={() => {
          setShowAddKeyModal(false)
          refreshEncryptionKeyInfo()
        }}
        context="generic"
      />
    </Card>
  )
}
