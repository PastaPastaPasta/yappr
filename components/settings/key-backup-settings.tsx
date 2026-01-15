'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'
import { getPrivateKey } from '@/lib/secure-storage'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CloudArrowUpIcon, TrashIcon, ShieldCheckIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'

export function KeyBackupSettings() {
  const { user } = useAuth()
  const [isConfigured, setIsConfigured] = useState(false)
  const [hasBackup, setHasBackup] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isDeleting, setIsDeleting] = useState(false)
  const [backupDate, setBackupDate] = useState<Date | null>(null)

  const checkBackupStatus = useCallback(async () => {
    if (!user) {
      setIsLoading(false)
      return
    }

    try {
      const configured = encryptedKeyService.isConfigured()
      setIsConfigured(configured)

      if (configured) {
        const backup = await encryptedKeyService.getBackupByIdentityId(user.identityId)
        setHasBackup(!!backup)
        if (backup) {
          setBackupDate(new Date(backup.$createdAt))
        }
      }
    } catch (error) {
      console.error('Error checking backup status:', error)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  useEffect(() => {
    void checkBackupStatus()
  }, [checkBackupStatus])

  const handleCreateBackup = async () => {
    if (!user) return

    // Get the private key from storage
    const privateKey = getPrivateKey(user.identityId)

    if (!privateKey) {
      toast.error('Cannot access private key. Please log in again.')
      return
    }

    // Open the backup modal
    const username = user.dpnsUsername || user.identityId
    useKeyBackupModal.getState().open(user.identityId, username, privateKey, false)
  }

  const handleDeleteBackup = async () => {
    if (!user) return

    if (!confirm('Are you sure you want to delete your on-chain key backup? You will need to use your private key to log in.')) {
      return
    }

    setIsDeleting(true)
    try {
      const success = await encryptedKeyService.deleteBackup(user.identityId)
      if (success) {
        setHasBackup(false)
        setBackupDate(null)
        toast.success('Backup deleted successfully')
      } else {
        toast.error('Failed to delete backup')
      }
    } catch (error) {
      console.error('Error deleting backup:', error)
      toast.error('Failed to delete backup')
    } finally {
      setIsDeleting(false)
    }
  }

  // Re-check backup status when modal closes (in case a backup was created)
  useEffect(() => {
    const unsubscribe = useKeyBackupModal.subscribe((state, prevState) => {
      if (prevState.isOpen && !state.isOpen) {
        // Modal just closed, refresh backup status
        void checkBackupStatus()
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
            On-Chain Key Backup
          </CardTitle>
          <CardDescription>
            On-chain key backup is not available
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500">
            The on-chain key backup feature is not yet configured for this network.
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
          On-Chain Key Backup
        </CardTitle>
        <CardDescription>
          Save an encrypted copy of your private key to Dash Platform
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasBackup ? (
          <>
            <div className="bg-green-50 dark:bg-green-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-green-900 dark:text-green-100">
                    Backup is active
                  </p>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    Your encrypted private key is stored on Dash Platform.
                    You can log in with your username and password.
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
                  Delete Backup
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
                    No backup found
                  </p>
                  <p className="text-sm text-orange-700 dark:text-orange-300">
                    Create an encrypted backup of your private key to enable username + password login.
                  </p>
                </div>
              </div>
            </div>

            <Button
              className="w-full"
              onClick={handleCreateBackup}
            >
              <CloudArrowUpIcon className="h-4 w-4 mr-2" />
              Create Backup
            </Button>
          </>
        )}

        <div className="pt-4 border-t">
          <h4 className="font-medium mb-2">How it works:</h4>
          <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              Your private key is encrypted with a strong passphrase you choose
            </li>
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              The encrypted key is stored publicly on Dash Platform
            </li>
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              Anyone with your password can decrypt and access your key
            </li>
            <li className="flex gap-2">
              <span className="text-purple-500">•</span>
              Use a strong, unique passphrase (16+ characters)
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
