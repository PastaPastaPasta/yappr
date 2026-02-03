'use client'

import { useEffect } from 'react'
import { CheckCircle, AlertCircle, Key } from 'lucide-react'
import { useKeyRegistration } from '@/hooks/use-key-registration'
import { KeyExchangeQR } from './key-exchange-qr'
import { Button } from '@/components/ui/button'

interface KeyRegistrationFlowProps {
  /** Identity ID to register keys for */
  identityId: string
  /** Auth private key (32 bytes) */
  authKey: Uint8Array
  /** Encryption private key (32 bytes) */
  encryptionKey: Uint8Array
  /** Called when registration completes successfully */
  onComplete: () => void
  /** Called when user cancels */
  onCancel: () => void
}

/**
 * Key Registration Flow Component
 *
 * Renders the UI for registering auth/encryption keys on an identity.
 * Shows a QR code with a dash-st: URI that the wallet scans to sign
 * and broadcast the IdentityUpdateTransition.
 *
 * States:
 * - building: Spinner while building transition
 * - waiting: QR code with countdown
 * - verifying: Brief "Checking keys..." message
 * - complete: Success checkmark
 * - error: Error message with retry button
 */
export function KeyRegistrationFlow({
  identityId,
  authKey,
  encryptionKey,
  onComplete,
  onCancel
}: KeyRegistrationFlowProps) {
  const {
    state,
    uri,
    remainingTime,
    error,
    start,
    cancel,
    retry
  } = useKeyRegistration('testnet', onComplete)

  // Start the registration flow when component mounts
  useEffect(() => {
    if (state === 'idle') {
      start(identityId, authKey, encryptionKey)
    }
  }, [identityId, authKey, encryptionKey, state, start])

  // Handle cancel
  const handleCancel = () => {
    cancel()
    onCancel()
  }

  // Render based on state
  const renderContent = () => {
    switch (state) {
      case 'idle':
      case 'building':
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
            <p className="text-gray-600 dark:text-gray-400">
              Preparing key registration...
            </p>
          </div>
        )

      case 'waiting':
        return (
          <div className="flex flex-col items-center gap-4">
            {/* Header */}
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <Key className="w-5 h-5" />
              <span className="font-medium">First Time Login</span>
            </div>

            {/* Explanation */}
            <p className="text-sm text-gray-600 dark:text-gray-400 text-center max-w-xs">
              Your login keys need to be added to your identity.
              Scan this QR code with Dash Evo Tool to complete setup.
            </p>

            {/* QR Code */}
            {uri && (
              <KeyExchangeQR
                uri={uri}
                size={200}
                remainingTime={remainingTime}
              />
            )}

            {/* Key info */}
            <div className="bg-gray-50 dark:bg-neutral-800 rounded-lg p-3 w-full">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Keys to be added:</p>
              <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
                <li className="flex items-center gap-2">
                  <span className="w-2 h-2 bg-green-500 rounded-full" />
                  Authentication key (HIGH security)
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-2 h-2 bg-blue-500 rounded-full" />
                  Encryption key (MEDIUM security)
                </li>
              </ul>
            </div>

            {/* Cancel button */}
            <button
              onClick={handleCancel}
              className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors mt-2"
            >
              Cancel
            </button>
          </div>
        )

      case 'verifying':
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500" />
            <p className="text-gray-600 dark:text-gray-400">
              Verifying key registration...
            </p>
          </div>
        )

      case 'complete':
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-full">
              <CheckCircle className="w-12 h-12 text-green-500" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold text-lg text-green-600 dark:text-green-400">
                Keys Registered!
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Completing login...
              </p>
            </div>
          </div>
        )

      case 'error':
        return (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-full">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold text-lg text-red-600 dark:text-red-400">
                Registration Error
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-xs">
                {error || 'An unexpected error occurred'}
              </p>
            </div>
            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button onClick={retry}>
                Try Again
              </Button>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="w-full">
      {renderContent()}
    </div>
  )
}
