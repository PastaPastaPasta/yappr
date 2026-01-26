'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  UserGroupIcon,
  ClockIcon,
  DocumentTextIcon,
  LockClosedIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { TREE_CAPACITY, MAX_EPOCH } from '@/lib/services'
import { formatTime } from '@/lib/utils'
import Link from 'next/link'
import { usePrivateFeedRefreshStore } from '@/lib/stores/private-feed-refresh-store'

interface ActivityItem {
  id: string
  type: 'approved' | 'revoked'
  userId: string
  username?: string
  displayName: string
  timestamp: Date
}

/**
 * PrivateFeedDashboard Component
 *
 * Dashboard showing private feed stats, epoch usage, and recent activity.
 * Implements PRD §4.10 - Private Feed Owner Dashboard
 */
export function PrivateFeedDashboard() {
  const { user } = useAuth()
  const [isLoading, setIsLoading] = useState(true)
  const [isEnabled, setIsEnabled] = useState(false)
  const [followerCount, setFollowerCount] = useState(0)
  const [pendingRequestCount, setPendingRequestCount] = useState(0)
  const [privatePostCount, setPrivatePostCount] = useState(0)
  const [currentEpoch, setCurrentEpoch] = useState(1)
  const [recentActivity, setRecentActivity] = useState<ActivityItem[]>([])
  const requestIdRef = useRef(0)
  const refreshKey = usePrivateFeedRefreshStore((s) => s.refreshKey)

  const loadDashboardData = useCallback(async () => {
    // Increment request ID to track this specific request
    const currentRequestId = ++requestIdRef.current

    if (!user?.identityId) {
      setIsLoading(false)
      setIsEnabled(false)
      setFollowerCount(0)
      setPendingRequestCount(0)
      setPrivatePostCount(0)
      setRecentActivity([])
      return
    }

    try {
      const {
        privateFeedService,
        privateFeedFollowerService,
      } = await import('@/lib/services')

      // Check if private feed is enabled
      const hasPrivateFeed = await privateFeedService.hasPrivateFeed(user.identityId)

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return

      setIsEnabled(hasPrivateFeed)

      if (!hasPrivateFeed) {
        setIsLoading(false)
        return
      }
      const { dpnsService } = await import('@/lib/services/dpns-service')
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
      const { postService } = await import('@/lib/services/post-service')

      // Get followers from grants
      const followers = await privateFeedService.getPrivateFollowers(user.identityId)

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return

      setFollowerCount(followers.length)

      // Get pending requests
      const requests = await privateFeedFollowerService.getFollowRequestsForOwner(user.identityId)

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return

      setPendingRequestCount(requests.length)

      // Get current epoch
      const epoch = await privateFeedService.getLatestEpoch(user.identityId)

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return

      setCurrentEpoch(epoch)

      // Count private posts by querying user's posts and filtering for those with encryptedContent
      // We'll do this by checking recent posts from the user
      try {
        const userPostsResult = await postService.getUserPosts(user.identityId, { limit: 100 })
        const privatePosts = userPostsResult.documents.filter(
          post => post.encryptedContent || post.epoch !== undefined
        )

        // Bail out if a newer request has started
        if (currentRequestId !== requestIdRef.current) return

        setPrivatePostCount(privatePosts.length)
      } catch (err) {
        console.error('Failed to count private posts:', err)
        if (currentRequestId !== requestIdRef.current) return
        setPrivatePostCount(0)
      }

      // Build recent activity from grants (approvals) and rekey documents (revocations)
      const activity: ActivityItem[] = []

      // Add approved followers as activity (sort by grantedAt descending to get most recent)
      const sortedFollowers = [...followers].sort((a, b) => b.grantedAt - a.grantedAt)
      for (const follower of sortedFollowers.slice(0, 5)) {
        // Bail out if a newer request has started
        if (currentRequestId !== requestIdRef.current) return

        let username: string | undefined
        let displayName = `User ${follower.recipientId.slice(-6)}`

        try {
          const resolvedUsername = await dpnsService.resolveUsername(follower.recipientId)
          if (resolvedUsername) username = resolvedUsername
        } catch {
          // Optional
        }

        try {
          const profile = await unifiedProfileService.getProfile(follower.recipientId)
          if (profile?.displayName) displayName = profile.displayName
        } catch {
          // Optional
        }

        activity.push({
          id: `grant-${follower.recipientId}`,
          type: 'approved',
          userId: follower.recipientId,
          username,
          displayName,
          timestamp: new Date(follower.grantedAt),
        })
      }

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return

      // Get rekey documents for revocation activity
      const rekeyDocs = await privateFeedService.getRekeyDocuments(user.identityId)

      // For revocations, we track them from rekey documents but don't have the user info directly
      // We can only show "Follower revoked" without the user details since grant is deleted
      for (const rekey of rekeyDocs.slice(-5).reverse()) {
        activity.push({
          id: `rekey-${rekey.epoch}`,
          type: 'revoked',
          userId: '',
          displayName: `Leaf ${rekey.revokedLeaf}`,
          timestamp: new Date(rekey.$createdAt),
        })
      }

      // Sort by timestamp descending and take top 5
      activity.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

      // Final bail out check before setting state
      if (currentRequestId !== requestIdRef.current) return

      setRecentActivity(activity.slice(0, 5))

    } catch (error) {
      console.error('Error loading dashboard data:', error)
    } finally {
      // Only update loading state if this is still the current request
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [user?.identityId])

  useEffect(() => {
    loadDashboardData().catch(err => console.error('Failed to load dashboard:', err))
  }, [loadDashboardData, refreshKey])

  // Calculate epoch usage percentage with clamping to avoid NaN/overflow
  const rawEpochPercent = MAX_EPOCH > 1 ? ((currentEpoch - 1) / (MAX_EPOCH - 1)) * 100 : 0
  const epochUsagePercent = Math.max(0, Math.min(100, rawEpochPercent))
  const isEpochWarning = epochUsagePercent > 90

  // Don't render anything if private feed is not enabled
  if (!isLoading && !isEnabled) {
    return null
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockClosedIcon className="h-5 w-5" />
            Your Private Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
              <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
              <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
            </div>
            <div className="h-16 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
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
          Your Private Feed
        </CardTitle>
        <CardDescription>
          Overview of your private feed activity and stats
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-4">
          {/* Followers */}
          <div data-testid="follower-count-stat" className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-950/50 dark:to-blue-900/30 p-4 rounded-xl text-center">
            <UserGroupIcon className="h-6 w-6 mx-auto mb-2 text-blue-600 dark:text-blue-400" />
            <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">{followerCount}</p>
            <p className="text-xs text-blue-600/70 dark:text-blue-400/70">/{TREE_CAPACITY}</p>
            <p className="text-xs font-medium text-blue-600 dark:text-blue-400 mt-1">Followers</p>
          </div>

          {/* Pending Requests */}
          <div data-testid="pending-requests-stat" className="bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-950/50 dark:to-amber-900/30 p-4 rounded-xl text-center">
            <ClockIcon className="h-6 w-6 mx-auto mb-2 text-amber-600 dark:text-amber-400" />
            <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{pendingRequestCount}</p>
            <p className="text-xs text-amber-600/70 dark:text-amber-400/70">&nbsp;</p>
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mt-1">Pending</p>
          </div>

          {/* Private Posts (recent sample) */}
          <div data-testid="private-posts-stat" className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-950/50 dark:to-purple-900/30 p-4 rounded-xl text-center">
            <DocumentTextIcon className="h-6 w-6 mx-auto mb-2 text-purple-600 dark:text-purple-400" />
            <p className="text-2xl font-bold text-purple-700 dark:text-purple-300">{privatePostCount}</p>
            <p className="text-xs text-purple-600/70 dark:text-purple-400/70">(recent)</p>
            <p className="text-xs font-medium text-purple-600 dark:text-purple-400 mt-1">Private Posts</p>
          </div>
        </div>

        {/* Epoch Usage */}
        <div data-testid="epoch-progress" className="space-y-2">
          <div className="flex justify-between items-center text-sm">
            <span className="font-medium">Epoch Usage</span>
            <span className={`text-sm ${isEpochWarning ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-gray-500'}`}>
              {currentEpoch - 1}/{MAX_EPOCH - 1} revocations
            </span>
          </div>
          <div className="h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                isEpochWarning
                  ? 'bg-gradient-to-r from-red-500 to-red-600'
                  : epochUsagePercent > 50
                  ? 'bg-gradient-to-r from-amber-400 to-amber-500'
                  : 'bg-gradient-to-r from-green-400 to-green-500'
              }`}
              style={{ width: `${Math.max(epochUsagePercent, 1)}%` }}
            />
          </div>
          {isEpochWarning && (
            <p className="text-xs text-red-600 dark:text-red-400">
              Your private feed is approaching its revocation limit. Contact support for migration options.
            </p>
          )}
          {!isEpochWarning && epochUsagePercent > 50 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {Math.round(100 - epochUsagePercent)}% of revocation capacity remaining
            </p>
          )}
        </div>

        {/* Recent Activity */}
        {recentActivity.length > 0 && (
          <div data-testid="recent-activity" className="border-t pt-4">
            <h4 className="font-medium text-sm mb-3">Recent Activity</h4>
            <div className="space-y-2">
              {recentActivity.map((activity) => (
                <div
                  key={activity.id}
                  className="flex items-center gap-3 text-sm py-2 px-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                >
                  {activity.type === 'approved' ? (
                    <CheckCircleIcon className="h-4 w-4 text-green-500 flex-shrink-0" />
                  ) : (
                    <XCircleIcon className="h-4 w-4 text-red-500 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    {activity.type === 'approved' ? (
                      <span>
                        {activity.username ? (
                          <Link
                            href={`/user?id=${activity.userId}`}
                            className="font-medium text-yappr-600 hover:underline"
                          >
                            @{activity.username}
                          </Link>
                        ) : (
                          <span className="font-medium">{activity.displayName}</span>
                        )}
                        {' '}approved
                      </span>
                    ) : (
                      <span>
                        <span className="font-medium">{activity.displayName}</span>
                        {' '}revoked
                      </span>
                    )}
                  </div>
                  <span className="text-gray-500 text-xs whitespace-nowrap">
                    {formatTime(activity.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
