'use client'

import { logger } from '@/lib/logger';
import { useEffect, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { LoadingState } from '@/components/ui/loading-state'
import { useDashPayContactsModal } from '@/hooks/use-dashpay-contacts-modal'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { dashPayContactsService, DashPayContact } from '@/lib/services/dashpay-contacts-service'
import { followService } from '@/lib/services/follow-service'
import toast from 'react-hot-toast'

export function DashPayContactsModal() {
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const {
    isOpen,
    state,
    contacts,
    totalMutualContacts,
    alreadyFollowedCount,
    error,
    followingIds,
    close,
    setLoading,
    setReady,
    setError,
    setFollowing,
    setFollowComplete,
    setFollowAll
  } = useDashPayContactsModal()

  const loadContacts = useCallback(async () => {
    if (!user) return
    setLoading()

    try {
      const result = await dashPayContactsService.getUnfollowedContacts(user.identityId)
      setReady(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts')
    }
  }, [user, setLoading, setReady, setError])

  // Load contacts when modal opens
  useEffect(() => {
    if (isOpen && user) {
      loadContacts().catch(err => logger.error('Failed to load contacts:', err))
    }
  }, [isOpen, user, loadContacts])

  const handleFollowOne = async (contact: DashPayContact) => {
    const authedUser = requireAuth('follow')
    if (!authedUser) return
    setFollowing(contact.identityId)

    try {
      const result = await followService.followUser(authedUser.identityId, contact.identityId)
      if (result.success) {
        setFollowComplete(contact.identityId)
        const displayName = contact.username || contact.displayName || 'user'
        toast.success(`Now following ${displayName}`)
      } else {
        toast.error(result.error || 'Failed to follow')
        // Remove from following set by completing (it will be filtered out)
        setFollowComplete(contact.identityId)
      }
    } catch (err) {
      toast.error('Failed to follow user')
      setFollowComplete(contact.identityId)
    }
  }

  const handleFollowAll = async () => {
    const authedUser = requireAuth('follow')
    if (!authedUser || contacts.length === 0) return
    setFollowAll()

    let successCount = 0
    const contactsCopy = [...contacts]

    for (const contact of contactsCopy) {
      try {
        setFollowing(contact.identityId)
        const result = await followService.followUser(authedUser.identityId, contact.identityId)
        if (result.success) {
          successCount++
          setFollowComplete(contact.identityId)
        }
      } catch (err) {
        logger.error('Failed to follow:', contact.identityId, err)
      }
    }

    if (successCount > 0) {
      toast.success(`Followed ${successCount} contact${successCount > 1 ? 's' : ''}`)
    }

    // Close modal if all followed
    if (successCount === contactsCopy.length) {
      setTimeout(() => close(), 1000)
    }
  }

  const handleClose = () => {
    if (state === 'following') return // Prevent closing during bulk follow
    close()
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-neutral-900 rounded-2xl p-0 w-[500px] max-w-[90vw] max-h-[600px] shadow-xl z-50 flex flex-col">
          {/* Header */}
          <div className="sticky top-0 bg-white dark:bg-neutral-900 border-b border-gray-200 dark:border-gray-800 px-4 py-3 flex items-center justify-between rounded-t-2xl">
            <Dialog.Title className="text-xl font-bold flex items-center gap-2">
              <UserGroupIcon className="h-6 w-6 text-blue-500" />
              Dash Pay Contacts
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full transition-colors disabled:opacity-50"
                disabled={state === 'following'}
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <LoadingState
              loading={state === 'loading'}
              error={error}
              isEmpty={state === 'ready' && contacts.length === 0}
              onRetry={loadContacts}
              loadingText="Finding your Dash Pay contacts..."
              emptyText="No unfollowed contacts"
              emptyDescription={
                totalMutualContacts > 0
                  ? `You're already following all ${totalMutualContacts} of your Dash Pay contacts!`
                  : "You don't have any mutual Dash Pay contacts yet."
              }
            >
              {/* Stats bar */}
              {contacts.length > 0 && (
                <div className="px-4 py-3 bg-gray-50 dark:bg-neutral-800 border-b border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Found <span className="font-semibold">{contacts.length}</span> Dash Pay
                    contact{contacts.length > 1 ? 's' : ''} you&apos;re not following
                    {alreadyFollowedCount > 0 && (
                      <span> (already following {alreadyFollowedCount})</span>
                    )}
                  </p>
                </div>
              )}

              {/* Contact list */}
              <div className="divide-y divide-gray-200 dark:divide-gray-800">
                {contacts.map((contact) => (
                  <ContactRow
                    key={contact.identityId}
                    contact={contact}
                    isFollowing={followingIds.has(contact.identityId)}
                    onFollow={() => handleFollowOne(contact)}
                  />
                ))}
              </div>
            </LoadingState>
          </div>

          {/* Footer with Follow All button */}
          {(state === 'ready' || state === 'following') && contacts.length > 1 && (
            <div className="sticky bottom-0 bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-gray-800 px-4 py-3 rounded-b-2xl">
              <Button
                onClick={handleFollowAll}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                disabled={state === 'following'}
              >
                {state === 'following' ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="sm" className="border-white" />
                    Following...
                  </span>
                ) : (
                  `Follow All (${contacts.length})`
                )}
              </Button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// Individual contact row component
function ContactRow({
  contact,
  isFollowing,
  onFollow
}: {
  contact: DashPayContact
  isFollowing: boolean
  onFollow: () => void
}) {
  const displayName = contact.displayName || contact.username || contact.identityId.slice(0, 8) + '...'
  const username = contact.username?.replace('.dash', '')

  return (
    <div className="p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarImage src={contact.avatarUrl} alt={displayName} crossOrigin="anonymous" />
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <p className="font-semibold">{displayName}</p>
            {username && (
              <p className="text-sm text-gray-500">@{username}</p>
            )}
          </div>
        </div>
        <Button
          variant={isFollowing ? 'outline' : 'default'}
          size="sm"
          onClick={onFollow}
          disabled={isFollowing}
          className={isFollowing ? '' : 'bg-blue-500 hover:bg-blue-600 text-white'}
        >
          {isFollowing ? (
            <span className="flex items-center gap-1">
              <span className="animate-spin">...</span>
            </span>
          ) : (
            'Follow'
          )}
        </Button>
      </div>
    </div>
  )
}
