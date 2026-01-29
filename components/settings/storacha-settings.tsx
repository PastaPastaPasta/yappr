'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  CloudArrowUpIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { getStorachaProvider } from '@/lib/upload'
import type { ProviderStatus } from '@/lib/upload'

/**
 * StorachaSettings Component
 *
 * Settings section for managing Storacha (IPFS) storage connection.
 * Allows users to connect their Storacha account via email verification.
 */
export function StorachaSettings() {
  const { user } = useAuth()
  const [status, setStatus] = useState<ProviderStatus>('disconnected')
  const [isLoading, setIsLoading] = useState(true)
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null)
  const [spaceDid, setSpaceDid] = useState<string | null>(null)

  // Connection flow state
  const [showEmailInput, setShowEmailInput] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)


  const checkConnectionStatus = useCallback(async () => {
    if (!user) {
      setIsLoading(false)
      return
    }

    try {
      const provider = getStorachaProvider()
      provider.setIdentityId(user.identityId)

      // Check if we have stored credentials
      const hasCredentials = provider.hasStoredCredentials()
      console.log('[Storacha] Checking credentials for identity:', user.identityId, 'hasCredentials:', hasCredentials)

      if (hasCredentials) {
        try {
          await provider.connect()
          setStatus('connected')
          setConnectedEmail(provider.getConnectedEmail())
          setSpaceDid(provider.getSpaceDid())
          console.log('[Storacha] Successfully connected')
        } catch (err) {
          // Credentials may be stale
          console.error('[Storacha] Failed to connect with stored credentials:', err)
          setStatus('disconnected')
        }
      } else {
        console.log('[Storacha] No stored credentials found')
        setStatus('disconnected')
      }

    } catch (error) {
      console.error('Error checking Storacha status:', error)
      setStatus('error')
    } finally {
      setIsLoading(false)
    }
  }, [user])

  useEffect(() => {
    checkConnectionStatus().catch(err => console.error('Failed to check status:', err))
  }, [checkConnectionStatus])

  const handleStartConnect = () => {
    setShowEmailInput(true)
    setConnectionError(null)
    setEmailInput('')
  }

  const handleCancelConnect = () => {
    setShowEmailInput(false)
    setEmailInput('')
    setConnectionError(null)
  }

  const handleConnect = async () => {
    if (!user || !emailInput.trim()) return

    setIsConnecting(true)
    setConnectionError(null)

    const provider = getStorachaProvider()
    provider.setIdentityId(user.identityId)

    // Poll provider status during connection to update UI in real-time
    const statusInterval = setInterval(() => {
      const providerStatus = provider.getStatus()
      setStatus(providerStatus)
    }, 500)

    try {
      // This will send verification email and wait for user to click link
      await provider.setupWithEmail(emailInput.trim())

      setStatus('connected')
      setConnectedEmail(provider.getConnectedEmail())
      setSpaceDid(provider.getSpaceDid())
      setShowEmailInput(false)
      setEmailInput('')
      toast.success('Storacha connected successfully!')
    } catch (error) {
      console.error('Failed to connect:', error)
      // Extract the underlying error message if available
      let message = 'Failed to connect'
      if (error instanceof Error) {
        message = error.message
        // Check for cause (UploadException stores original error)
        const cause = (error as { cause?: Error }).cause
        if (cause) {
          console.error('Underlying error:', cause)
          message = `${error.message}: ${cause.message}`
        }
      }
      setConnectionError(message)

      // Update status based on error
      setStatus(provider.getStatus())
    } finally {
      clearInterval(statusInterval)
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    if (!confirm('Disconnect from Storacha? Your credentials will be cleared from this browser.')) {
      return
    }

    try {
      const provider = getStorachaProvider()
      await provider.disconnect(true)

      setStatus('disconnected')
      setConnectedEmail(null)
      setSpaceDid(null)
      toast.success('Disconnected from Storacha')
    } catch (error) {
      console.error('Failed to disconnect:', error)
      toast.error('Failed to disconnect')
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="animate-pulse space-y-2">
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
          <CloudArrowUpIcon className="h-5 w-5" />
          Storage Provider
        </CardTitle>
        <CardDescription>
          Connect a storage provider to attach images to your posts
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === 'connected' ? (
          <>
            <div className="bg-green-50 dark:bg-green-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-green-900 dark:text-green-100">
                    Storacha connected
                  </p>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    You can now attach images to your posts.
                    {connectedEmail && (
                      <span className="block mt-1 text-xs">
                        Email: {connectedEmail}
                      </span>
                    )}
                    {spaceDid && (
                      <span className="block text-xs font-mono truncate max-w-[250px]" title={spaceDid}>
                        Space: {spaceDid}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Note about local storage */}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Credentials stored locally on this device. Re-authenticate via email on new devices.
            </p>

            <Button
              variant="outline"
              className="w-full text-red-600 hover:text-red-700 hover:border-red-300"
              onClick={handleDisconnect}
            >
              Disconnect
            </Button>
          </>
        ) : status === 'verification_pending' ? (
          <div className="space-y-4">
            <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <Loader2 className="h-5 w-5 text-amber-600 dark:text-amber-400 animate-spin flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    Waiting for email verification
                  </p>
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Please check your email and click the verification link.
                  </p>
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                const provider = getStorachaProvider()
                provider.disconnect(false).catch(console.error)
                setStatus('disconnected')
                setIsConnecting(false)
                setShowEmailInput(false)
              }}
            >
              Cancel
            </Button>
          </div>
        ) : status === 'awaiting_plan' ? (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-lg">
              <div className="flex gap-3">
                <Loader2 className="h-5 w-5 text-blue-600 dark:text-blue-400 animate-spin flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
                    Select a storage plan
                  </p>
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    Please visit{' '}
                    <a
                      href="https://console.storacha.network"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline font-medium"
                    >
                      console.storacha.network
                    </a>
                    {' '}to select a plan (free tier available with 5GB).
                  </p>
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                const provider = getStorachaProvider()
                provider.disconnect(false).catch(console.error)
                setStatus('disconnected')
                setIsConnecting(false)
                setShowEmailInput(false)
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <>
            {!showEmailInput ? (
              <>
                <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                  <div className="space-y-3">
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      Connect to Storacha to upload images to IPFS
                    </p>
                    <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                      <li className="flex gap-2">
                        <span className="text-yappr-500">•</span>
                        Images are stored on decentralized IPFS network
                      </li>
                      <li className="flex gap-2">
                        <span className="text-yappr-500">•</span>
                        Free tier includes 5GB of storage
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="bg-amber-50 dark:bg-amber-950 p-3 rounded-lg">
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    <strong>Note:</strong> Storacha is a third-party service. New accounts require email verification and selecting a plan at{' '}
                    <a
                      href="https://console.storacha.network"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      console.storacha.network
                    </a>
                    . The free tier may require credit card verification.
                  </p>
                </div>

                <Button className="w-full" onClick={handleStartConnect}>
                  <CloudArrowUpIcon className="h-4 w-4 mr-2" />
                  Connect to Storacha
                </Button>
              </>
            ) : (
              <>
                <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-lg">
                  <div className="flex gap-3">
                    <EnvelopeIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
                        Email verification required
                      </p>
                      <p className="text-sm text-blue-700 dark:text-blue-300">
                        Enter your email address. You&apos;ll receive a verification link to complete the connection.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Email Address</label>
                  <Input
                    type="email"
                    placeholder="[email protected]"
                    value={emailInput}
                    onChange={(e) => {
                      setEmailInput(e.target.value)
                      setConnectionError(null)
                    }}
                    disabled={isConnecting}
                  />
                  {connectionError && (
                    <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                      <ExclamationTriangleIcon className="h-4 w-4" />
                      {connectionError}
                    </p>
                  )}
                </div>

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
                    disabled={isConnecting || !emailInput.trim()}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {(status as ProviderStatus) === 'verification_pending' ? 'Waiting...' : 'Connecting...'}
                      </>
                    ) : (
                      <>
                        <ArrowPathIcon className="h-4 w-4 mr-2" />
                        Connect
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}

            {status === 'error' && connectionError && (
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

        <div className="pt-4 border-t">
          <h4 className="font-medium mb-2 text-sm">How it works:</h4>
          <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <li className="flex gap-2">
              <span className="text-yappr-500">•</span>
              Images are uploaded to IPFS via Storacha
            </li>
            <li className="flex gap-2">
              <span className="text-yappr-500">•</span>
              Posts reference images using <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">ipfs://CID</code> URLs
            </li>
            <li className="flex gap-2">
              <span className="text-yappr-500">•</span>
              Images are publicly accessible via IPFS gateways
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
