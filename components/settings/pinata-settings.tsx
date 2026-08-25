'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ArrowTopRightOnSquareIcon,
  KeyIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { getPinataProvider } from '@/lib/upload/providers/pinata/pinata-provider'
import type { ProviderStatus } from '@/lib/upload'

interface PinataSettingsProps {
  /** Whether this provider section is disabled (another provider is connected) */
  disabled?: boolean
  /** Callback when connection status changes */
  onConnectionChange?: (connected: boolean) => void
}

/**
 * PinataSettings Component
 *
 * Settings section for managing Pinata IPFS storage connection.
 * Allows users to connect using their Pinata API key (JWT).
 */
export function PinataSettings({ disabled, onConnectionChange }: PinataSettingsProps) {
  const { user } = useAuth()
  const [status, setStatus] = useState<ProviderStatus>('disconnected')
  const [isLoading, setIsLoading] = useState(true)
  const [maskedJwt, setMaskedJwt] = useState<string | null>(null)
  const [gateway, setGateway] = useState<string | null>(null)

  // Connection flow state
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [jwtInput, setJwtInput] = useState('')
  const [gatewayInput, setGatewayInput] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)

  // Use ref for onConnectionChange to avoid effect re-runs when parent re-renders
  const onConnectionChangeRef = useRef(onConnectionChange)
  useEffect(() => {
    onConnectionChangeRef.current = onConnectionChange
  }, [onConnectionChange])

  const checkConnectionStatus = useCallback(async () => {
    if (!user) {
      setIsLoading(false)
      return
    }

    try {
      const provider = getPinataProvider()
      provider.setIdentityId(user.identityId)

      // Check if we have stored credentials
      const hasCredentials = provider.hasStoredCredentials()
      logger.info('[Pinata] Checking credentials for identity:', user.identityId, 'hasCredentials:', hasCredentials)

      if (hasCredentials) {
        try {
          await provider.connect()
          setStatus('connected')
          setMaskedJwt(provider.getMaskedJwt())
          setGateway(provider.getConnectedGateway())
          onConnectionChangeRef.current?.(true)
          logger.info('[Pinata] Successfully connected')
        } catch (err) {
          logger.error('[Pinata] Failed to connect with stored credentials:', err)
          setStatus('disconnected')
          onConnectionChangeRef.current?.(false)
        }
      } else {
        logger.info('[Pinata] No stored credentials found')
        setStatus('disconnected')
        onConnectionChangeRef.current?.(false)
      }

    } catch (error) {
      logger.error('Error checking Pinata status:', error)
      setStatus('error')
      onConnectionChangeRef.current?.(false)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  useEffect(() => {
    checkConnectionStatus().catch(err => logger.error('Failed to check status:', err))
  }, [checkConnectionStatus])

  const handleStartConnect = () => {
    setShowApiKeyInput(true)
    setConnectionError(null)
    setJwtInput('')
    setGatewayInput('')
  }

  const handleCancelConnect = () => {
    setShowApiKeyInput(false)
    setJwtInput('')
    setGatewayInput('')
    setConnectionError(null)
  }

  const handleConnect = async () => {
    if (!user || !jwtInput.trim()) return

    setIsConnecting(true)
    setConnectionError(null)

    const provider = getPinataProvider()
    provider.setIdentityId(user.identityId)

    try {
      await provider.setupWithApiKey(
        jwtInput.trim(),
        gatewayInput.trim() || undefined
      )

      setStatus('connected')
      setMaskedJwt(provider.getMaskedJwt())
      setGateway(provider.getConnectedGateway())
      setShowApiKeyInput(false)
      setJwtInput('')
      setGatewayInput('')
      onConnectionChange?.(true)
      toast.success('Pinata connected successfully!')
    } catch (error) {
      logger.error('Failed to connect:', error)
      let message = 'Failed to connect'
      if (error instanceof Error) {
        message = error.message
      }
      setConnectionError(message)
      setStatus(provider.getStatus())
    } finally {
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    if (!confirm('Disconnect from Pinata? Your API key will be cleared from this browser.')) {
      return
    }

    try {
      const provider = getPinataProvider()
      await provider.disconnect(true)

      setStatus('disconnected')
      setMaskedJwt(null)
      setGateway(null)
      onConnectionChange?.(false)
      toast.success('Disconnected from Pinata')
    } catch (error) {
      logger.error('Failed to disconnect:', error)
      toast.error('Failed to disconnect')
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <KeyIcon className="h-5 w-5 text-gray-400" />
          <span className="font-medium">Pinata</span>
        </div>
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-3/4"></div>
        </div>
      </div>
    )
  }

  // Disabled state - another provider is connected
  if (disabled && status !== 'connected') {
    return (
      <div className="space-y-3 opacity-60">
        <div className="flex items-center gap-2">
          <KeyIcon className="h-5 w-5 text-gray-400" />
          <span className="font-medium">Pinata</span>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg">
          <p className="text-sm text-gray-500">
            Disconnect the other provider first to switch to Pinata.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyIcon className="h-5 w-5 text-gray-400" />
        <span className="font-medium">Pinata</span>
        {status === 'connected' && (
          <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full">
            Connected
          </span>
        )}
      </div>

      {status === 'connected' ? (
        <>
          <div className="bg-green-50 dark:bg-green-950 p-4 rounded-lg">
            <div className="flex gap-3">
              <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-green-900 dark:text-green-100">
                  Pinata connected
                </p>
                <p className="text-sm text-green-700 dark:text-green-300">
                  You can now attach images to your posts.
                  {maskedJwt && (
                    <span className="block mt-1 text-xs font-mono">
                      API Key: {maskedJwt}
                    </span>
                  )}
                  {gateway && (
                    <span className="block text-xs font-mono">
                      Gateway: {gateway}
                    </span>
                  )}
                </p>
              </div>
            </div>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            API key stored locally on this device. Re-enter on new devices.
          </p>

          <Button
            variant="outline"
            className="w-full text-red-600 hover:text-red-700 hover:border-red-300"
            onClick={handleDisconnect}
          >
            Disconnect
          </Button>
        </>
      ) : (
        <>
          {!showApiKeyInput ? (
            <>
              <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  1GB free tier, no credit card required.
                </p>
              </div>

              <Button
                className="w-full"
                onClick={handleStartConnect}
                disabled={disabled}
              >
                <KeyIcon className="h-4 w-4 mr-2" />
                Connect with JWT
              </Button>
            </>
          ) : (
            <>
              <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-lg">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
                    Enter your Pinata JWT
                  </p>
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    Create an API key with <strong>Files: Write</strong> permission, then copy the <strong>JWT (secret access token)</strong>.
                  </p>
                  <a
                    href="https://app.pinata.cloud/developers/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Open Pinata Dashboard
                    <ArrowTopRightOnSquareIcon className="h-3 w-3" />
                  </a>
                </div>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">JWT (secret access token)</label>
                  <Input
                    type="password"
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                    value={jwtInput}
                    onChange={(e) => {
                      setJwtInput(e.target.value)
                      setConnectionError(null)
                    }}
                    disabled={isConnecting}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Gateway Domain <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <Input
                    type="text"
                    placeholder="my-gateway.mypinata.cloud"
                    value={gatewayInput}
                    onChange={(e) => setGatewayInput(e.target.value)}
                    disabled={isConnecting}
                  />
                  <p className="text-xs text-gray-500">
                    Your custom gateway for faster content delivery.
                  </p>
                </div>

                {connectionError && (
                  <div className="bg-red-50 dark:bg-red-950 p-3 rounded-lg">
                    <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                      <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
                      {connectionError}
                    </p>
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={handleCancelConnect}
                    disabled={isConnecting}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleConnect}
                    disabled={isConnecting || !jwtInput.trim()}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Connecting...
                      </>
                    ) : (
                      'Connect'
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}

          {status === 'error' && connectionError && !showApiKeyInput && (
            <div className="bg-red-50 dark:bg-red-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-red-900 dark:text-red-100">
                    Connection failed
                  </p>
                  <p className="text-sm text-red-700 dark:text-red-300">
                    {connectionError}
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
