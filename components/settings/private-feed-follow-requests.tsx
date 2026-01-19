'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LockClosedIcon, UserPlusIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import Link from 'next/link'

interface FollowRequestUser {
  id: string
  requestId: string
  username?: string
  displayName: string
  hasDpns: boolean
  requestedAt: Date
  publicKey?: Uint8Array
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minute${Math.floor(seconds / 60) !== 1 ? 's' : ''} ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hour${Math.floor(seconds / 3600) !== 1 ? 's' : ''} ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} day${Math.floor(seconds / 86400) !== 1 ? 's' : ''} ago`
  return date.toLocaleDateString()
}

export function PrivateFeedFollowRequests() {
  const { user } = useAuth()
  const [requests, setRequests] = useState<FollowRequestUser[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [hasPrivateFeed, setHasPrivateFeed] = useState(false)

  const loadRequests = useCallback(async () => {
    if (!user?.identityId) {
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const { privateFeedService, privateFeedFollowerService } = await import('@/lib/services')
      const { dpnsService } = await import('@/lib/services/dpns-service')
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

      // Check if user has private feed enabled
      const hasFeed = await privateFeedService.hasPrivateFeed(user.identityId)
      setHasPrivateFeed(hasFeed)

      if (!hasFeed) {
        setRequests([])
        return
      }

      // Get all follow requests targeting this user
      const followRequests = await privateFeedFollowerService.getFollowRequestsForOwner(user.identityId)

      if (followRequests.length === 0) {
        setRequests([])
        return
      }

      // Resolve usernames and profiles for requesters
      const requestsWithDetails = await Promise.all(
        followRequests.map(async (request) => {
          const requesterId = request.$ownerId
          let username: string | undefined
          let displayName = `User ${requesterId.slice(-6)}`
          let hasDpns = false

          // Try to get DPNS username
          try {
            const resolvedUsername = await dpnsService.resolveUsername(requesterId)
            if (resolvedUsername) {
              username = resolvedUsername
              hasDpns = true
            }
          } catch {
            // DPNS resolution is optional
          }

          // Try to get profile display name
          try {
            const profile = await unifiedProfileService.getProfile(requesterId)
            if (profile?.displayName) {
              displayName = profile.displayName
            }
          } catch {
            // Profile is optional
          }

          return {
            id: requesterId,
            requestId: request.$id,
            username,
            displayName,
            hasDpns,
            requestedAt: new Date(request.$createdAt),
            publicKey: request.publicKey
          }
        })
      )

      setRequests(requestsWithDetails)
    } catch (error) {
      console.error('Error loading follow requests:', error)
      toast.error('Failed to load follow requests')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId])

  useEffect(() => {
    loadRequests().catch(err => console.error('Failed to load follow requests:', err))
  }, [loadRequests])

  const handleApprove = async (request: FollowRequestUser) => {
    if (!user?.identityId || processingId) return

    setProcessingId(request.id)

    try {
      const { privateFeedService, identityService } = await import('@/lib/services')

      // Get requester's public encryption key
      let publicKey = request.publicKey

      if (!publicKey) {
        // Try to fetch from identity
        const identity = await identityService.getIdentity(request.id)
        if (identity?.publicKeys) {
          // Find encryption key (purpose 0 = AUTHENTICATION, 1 = ENCRYPTION)
          // Look for secp256k1 key (type 0) with encryption purpose
          const encryptionKey = identity.publicKeys.find(
            (k) => k.purpose === 1 && k.type === 0 && !k.disabledAt
          )
          if (encryptionKey?.data) {
            // Convert data to Uint8Array
            if (typeof encryptionKey.data === 'string') {
              // Base64 or hex
              if (/^[0-9a-fA-F]+$/.test(encryptionKey.data)) {
                const hexPairs = encryptionKey.data.match(/.{1,2}/g) || []
                publicKey = new Uint8Array(
                  hexPairs.map(byte => parseInt(byte, 16))
                )
              } else {
                // Base64
                const binary = atob(encryptionKey.data)
                publicKey = new Uint8Array(binary.length)
                for (let i = 0; i < binary.length; i++) {
                  publicKey[i] = binary.charCodeAt(i)
                }
              }
            } else if (encryptionKey.data instanceof Uint8Array) {
              publicKey = encryptionKey.data
            } else if (Array.isArray(encryptionKey.data)) {
              publicKey = new Uint8Array(encryptionKey.data)
            }
          }
        }
      }

      if (!publicKey) {
        toast.error('This user needs to set up an encryption key before you can approve their request')
        setProcessingId(null)
        return
      }

      // Try to get encryption key for automatic sync/recovery
      const { getEncryptionKey } = await import('@/lib/secure-storage')
      const storedKeyHex = getEncryptionKey(user.identityId)
      let encryptionPrivateKey: Uint8Array | undefined
      if (storedKeyHex) {
        encryptionPrivateKey = new Uint8Array(
          storedKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
        )
      }

      // Approve the follower
      const result = await privateFeedService.approveFollower(
        user.identityId,
        request.id,
        publicKey,
        encryptionPrivateKey
      )

      if (result.success) {
        // Remove from local state
        setRequests(prev => prev.filter(r => r.id !== request.id))
        toast.success(`Approved ${request.username ? `@${request.username}` : request.displayName}`)
      } else {
        // Check if this is a sync required error
        if (result.error?.startsWith('SYNC_REQUIRED:')) {
          const { useEncryptionKeyModal } = await import('@/hooks/use-encryption-key-modal')
          useEncryptionKeyModal.getState().open('sync_state', () => {
            toast('Please try approving again now that your keys are synced')
          })
          toast.error('Your private feed state needs to sync. Please enter your encryption key.')
          setProcessingId(null)
          return
        }
        throw new Error(result.error || 'Failed to approve follower')
      }
    } catch (error) {
      console.error('Error approving follower:', error)
      toast.error('Failed to approve follower')
    } finally {
      setProcessingId(null)
    }
  }

  const handleIgnore = async (request: FollowRequestUser) => {
    if (!user?.identityId || processingId) return

    // For now, just remove from UI (the request remains on-chain but is hidden)
    // User can approve later if they change their mind
    setRequests(prev => prev.filter(r => r.id !== request.id))
    toast.success('Request ignored')
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlusIcon className="h-5 w-5" />
            Private Feed Requests
          </CardTitle>
          <CardDescription>
            Manage requests to access your private feed
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2].map(i => (
              <div key={i} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
                  <div>
                    <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
                    <div className="h-3 w-16 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="h-8 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                  <div className="h-8 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!hasPrivateFeed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlusIcon className="h-5 w-5" />
            Private Feed Requests
          </CardTitle>
          <CardDescription>
            Manage requests to access your private feed
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg text-center">
            <LockClosedIcon className="h-8 w-8 mx-auto text-gray-400 mb-2" />
            <p className="text-gray-500 text-sm">
              Enable your private feed to receive access requests
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlusIcon className="h-5 w-5" />
          Private Feed Requests
          {requests.length > 0 && (
            <span className="ml-auto bg-yappr-500 text-white text-xs px-2 py-0.5 rounded-full">
              {requests.length}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Approve or ignore requests to access your private feed
        </CardDescription>
      </CardHeader>
      <CardContent>
        {requests.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">
            No pending requests
          </p>
        ) : (
          <div className="space-y-3">
            {requests.map(request => (
              <div
                key={request.id}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-950 rounded-lg"
              >
                <Link
                  href={`/user?id=${request.id}`}
                  className="flex items-center gap-3 hover:opacity-80 transition-opacity flex-1 min-w-0"
                >
                  <UserAvatar userId={request.id} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{request.displayName}</p>
                    {request.hasDpns && request.username && (
                      <p className="text-sm text-gray-500 truncate">@{request.username}</p>
                    )}
                    <p className="text-xs text-gray-400">
                      Requested {formatTimeAgo(request.requestedAt)}
                    </p>
                  </div>
                </Link>
                <div className="flex gap-2 flex-shrink-0 ml-2">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => handleApprove(request)}
                    disabled={processingId === request.id}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {processingId === request.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <CheckIcon className="h-4 w-4 mr-1" />
                        Approve
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleIgnore(request)}
                    disabled={processingId === request.id}
                  >
                    <XMarkIcon className="h-4 w-4 mr-1" />
                    Ignore
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
