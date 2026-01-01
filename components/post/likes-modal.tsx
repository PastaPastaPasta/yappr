'use client'

import { useState, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { LoadingState } from '@/components/ui/loading-state'
import { useAsyncState } from '@/components/ui/loading-state'
import { likeService, LikeDocument } from '@/lib/services/like-service'
import { formatTime } from '@/lib/utils'

interface LikesModalProps {
  isOpen: boolean
  onClose: () => void
  postId: string
}

interface LikeWithUser extends LikeDocument {
  username?: string
  displayName?: string
}

export function LikesModal({ isOpen, onClose, postId }: LikesModalProps) {
  const likesState = useAsyncState<LikeWithUser[]>([])

  const loadLikes = async () => {
    const { setLoading, setError, setData } = likesState
    setLoading(true)
    setError(null)

    try {
      // Fetch actual likes from Dash Platform
      const likes = await likeService.getPostLikes(postId)
      
      // Transform likes to include user info
      // For now, we'll generate usernames from the ownerId
      const likesWithUsers: LikeWithUser[] = likes.map(like => ({
        ...like,
        username: `user_${like.$ownerId.slice(-6)}`,
        displayName: `User ${like.$ownerId.slice(-6)}`
      }))
      
      setData(likesWithUsers)
    } catch (error) {
      console.error('Failed to load likes:', error)
      setError(error instanceof Error ? error.message : 'Failed to load likes')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadLikes()
    }
  }, [isOpen])

  return (
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-black rounded-2xl p-0 w-[500px] max-h-[600px] shadow-xl z-50">
          <div className="sticky top-0 bg-white dark:bg-black border-b border-gray-200 dark:border-gray-800 px-4 py-3 flex items-center justify-between">
            <Dialog.Title className="text-xl font-bold">
              Liked by
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full transition-colors">
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
                          <p className="text-sm text-gray-500">@{like.username} · {formatTime(new Date(like.$createdAt))}</p>
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