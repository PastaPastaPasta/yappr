'use client'

import { useEffect, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { LoadingState } from '@/components/ui/loading-state'
import { useAsyncState } from '@/components/ui/loading-state'
import { likeService, LikeDocument } from '@/lib/services/like-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { formatTime } from '@/lib/utils'
import * as Tooltip from '@radix-ui/react-tooltip'
import toast from 'react-hot-toast'

interface LikesModalProps {
  isOpen: boolean
  onClose: () => void
  postId: string
}

interface LikeWithUser extends LikeDocument {
  username?: string | null
  displayName?: string
  hasDpnsName: boolean
  hasProfile: boolean
}

export function LikesModal({ isOpen, onClose, postId }: LikesModalProps) {
  const likesState = useAsyncState<LikeWithUser[]>([])
  const { setLoading, setError, setData } = likesState

  const loadLikes = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      // Fetch actual likes from Dash Platform
      const likes = await likeService.getPostLikes(postId)

      if (likes.length === 0) {
        setData([])
        return
      }

      // Get unique owner IDs
      const ownerIds = likes.map(like => like.$ownerId).filter(Boolean)

      // Batch fetch DPNS usernames and profiles
      const [usernameMap, profiles] = await Promise.all([
        dpnsService.resolveUsernamesBatch(ownerIds),
        unifiedProfileService.getProfilesByIdentityIds(ownerIds)
      ])

      // Create profile lookup map
      const profileMap = new Map(profiles.map(p => [p.$ownerId, p]))

      // Transform likes with resolved user info
      const likesWithUsers: LikeWithUser[] = likes.map(like => {
        const username = usernameMap.get(like.$ownerId)
        const profile = profileMap.get(like.$ownerId)
        const profileDisplayName = profile?.displayName

        return {
          ...like,
          username: username || null,
          displayName: profileDisplayName || username || `User ${like.$ownerId.slice(-6)}`,
          hasDpnsName: !!username,
          hasProfile: !!profileDisplayName
        }
      })

      setData(likesWithUsers)
    } catch (error) {
      console.error('Failed to load likes:', error)
      setError(error instanceof Error ? error.message : 'Failed to load likes')
    } finally {
      setLoading(false)
    }
  }, [postId, setLoading, setError, setData])

  useEffect(() => {
    if (isOpen) {
      loadLikes().catch(err => console.error('Failed to load likes:', err))
    }
  }, [isOpen, loadLikes])

  return (
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-surface-900 rounded-2xl p-0 w-[500px] max-h-[600px] shadow-xl z-50">
          <div className="sticky top-0 bg-white dark:bg-surface-900 border-b border-surface-200 dark:border-neutral-750 px-4 py-3 flex items-center justify-between">
            <Dialog.Title className="text-xl font-bold">
              Liked by
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-full transition-colors">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            <LoadingState
              loading={likesState.loading}
              error={likesState.error}
              isEmpty={likesState.data?.length === 0}
              onRetry={loadLikes}
              loadingText="Loading likes..."
              emptyText="No likes yet"
              emptyDescription="Be the first to like this post!"
            >
              <div className="divide-y divide-gray-200 dark:divide-gray-800">
                {(likesState.data ?? []).map((like) => (
                  <div key={like.$id} className="p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Avatar>
                          <AvatarFallback>{like.$ownerId.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-semibold">{like.displayName}</p>
                          {like.hasDpnsName ? (
                            // Has DPNS: show @username
                            <p className="text-sm text-gray-500">@{like.username} · {formatTime(new Date(like.$createdAt))}</p>
                          ) : like.hasProfile ? (
                            // Has profile but no DPNS: just show timestamp
                            <p className="text-sm text-gray-500">{formatTime(new Date(like.$createdAt))}</p>
                          ) : (
                            // No DPNS and no profile: show identity ID
                            <div className="flex items-center gap-1 text-sm text-gray-500">
                              <Tooltip.Provider>
                                <Tooltip.Root>
                                  <Tooltip.Trigger asChild>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        navigator.clipboard.writeText(like.$ownerId)
                                          .then(() => toast.success('Identity ID copied'))
                                          .catch(() => toast.error('Failed to copy ID'))
                                      }}
                                      className="font-mono text-xs hover:text-gray-700 dark:hover:text-gray-300"
                                    >
                                      {like.$ownerId.slice(0, 8)}...{like.$ownerId.slice(-6)}
                                    </button>
                                  </Tooltip.Trigger>
                                  <Tooltip.Portal>
                                    <Tooltip.Content
                                      className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded"
                                      sideOffset={5}
                                    >
                                      Click to copy full identity ID
                                    </Tooltip.Content>
                                  </Tooltip.Portal>
                                </Tooltip.Root>
                              </Tooltip.Provider>
                              <span>· {formatTime(new Date(like.$createdAt))}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <Button variant="outline" size="sm">
                        Follow
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </LoadingState>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}