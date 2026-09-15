'use client'

import { useMemo } from 'react'
import { Modal, ModalTitle } from './modal'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { isUsernameContested, sortUsernames } from '@/lib/utils/username'

interface UsernamesModalProps {
  isOpen: boolean
  onClose: () => void
  usernames: string[]
  primaryUsername: string
  identityId: string
}

export function UsernamesModal({ isOpen, onClose, usernames, primaryUsername, identityId }: UsernamesModalProps) {
  // Canonical ordering (contested first, then shortest, then alphabetically),
  // so the primary username always appears first - memoized to avoid re-sorting on every render
  const sortedUsernames = useMemo(() => sortUsernames(usernames), [usernames])

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()} className="w-[400px] max-w-[90vw]">
      <button
        type="button"
        className="absolute right-4 top-4 rounded-md text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
        onClick={onClose}
      >
        <span className="sr-only">Close</span>
        <XMarkIcon className="h-6 w-6" aria-hidden="true" />
      </button>
      <ModalTitle className="text-lg mb-4">All Usernames</ModalTitle>
      <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <p className="text-xs text-gray-500 dark:text-gray-400">Identity ID</p>
        <p className="text-sm font-mono text-gray-900 dark:text-white break-all">{identityId}</p>
      </div>
      <div className="space-y-2">
        {sortedUsernames.map((username) => {
          const isContested = isUsernameContested(username)
          const isPrimary = username === primaryUsername
          return (
            <div
              key={username}
              className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                isPrimary ? 'bg-purple-50 dark:bg-purple-900/20' : 'bg-gray-50 dark:bg-gray-800'
              }`}
            >
              <span className="text-sm font-medium text-gray-900 dark:text-white">@{username}</span>
              <div className="flex items-center gap-2">
                {isPrimary && (
                  <span className="text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-2 py-1 rounded">
                    Primary
                  </span>
                )}
                {isContested && (
                  <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-1 rounded">
                    Contested
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
