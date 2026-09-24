'use client'

import { XMarkIcon } from '@heroicons/react/24/outline'
import { Spinner } from '@/components/ui/spinner'
import type { RecoveryProgress } from '@/lib/services/dm-v5'

const PHASE_TEXT: Record<RecoveryProgress['phase'], string> = {
  invites: 'Finding conversations people started with you',
  'contacts-recent': 'Checking recent chats with people you follow',
  groups: 'Finding your groups',
  'contacts-older': 'Checking older chats with people you follow',
  done: 'Done',
}

interface DmNoticesProps {
  recovery: RecoveryProgress | null
  capReached: boolean
  showMigration: boolean
  onDismissMigration: () => void
  error: string | null
}

/** Status notices above the conversation list: recovery progress, the self-state cap, the §10 migration notice. */
export function DmNotices({ recovery, capReached, showMigration, onDismissMigration, error }: DmNoticesProps) {
  return (
    <div className="flex-shrink-0">
      {recovery && (
        <div role="status" className="flex items-start gap-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 p-3 text-sm">
          <Spinner size="sm" className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Restoring your messages</p>
            <p className="text-gray-500">
              {PHASE_TEXT[recovery.phase]}
              {recovery.total > 0 ? ` (${recovery.done}/${recovery.total})` : recovery.done > 0 ? ` (${recovery.done} checked)` : ''}. {recovery.found} found so far.
            </p>
          </div>
        </div>
      )}
      {capReached && (
        <div role="status" className="border-b border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-800 dark:text-amber-300">
          You have reached the limit of about 290 saved conversations. New conversations still show here, but they are not saved, so your other
          devices will not see them. Blocking people who send you unwanted messages stops them taking up more room.
        </div>
      )}
      {showMigration && (
        <div className="flex items-start gap-2 border-b border-gray-200 dark:border-gray-800 bg-yappr-50 dark:bg-yappr-950/30 p-3 text-sm">
          <p className="flex-1">
            Messaging is now more private: nobody watching the blockchain can tell who you talk to. Your earlier conversations are still here, but they
            were stored the old way, so who you talked to in them is public and will stay that way. Everything you send from now on uses the new system.
          </p>
          <button aria-label="Dismiss" onClick={onDismissMigration} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full flex-shrink-0">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )}
      {error && <p role="alert" className="border-b border-gray-200 dark:border-gray-800 p-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}
