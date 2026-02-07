'use client'

import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { cn } from '@/lib/utils'
import type { UsernameEntry } from '@/lib/types'

type RegistrationState = 'pending' | 'current' | 'success' | 'failed'

function getRegistrationState(
  index: number,
  currentIndex: number,
  entry: UsernameEntry
): RegistrationState {
  if (index === currentIndex) {
    return 'current'
  }
  if (index < currentIndex) {
    return entry.registrationError ? 'failed' : 'success'
  }
  return 'pending'
}

function getRowStyles(state: RegistrationState): string {
  switch (state) {
    case 'current':
      return 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
    case 'success':
      return 'border-green-500 bg-green-50 dark:bg-green-900/20'
    case 'failed':
      return 'border-red-500 bg-red-50 dark:bg-red-900/20'
    case 'pending':
      return 'border-surface-200 dark:border-surface-700 opacity-50'
  }
}

function RegistrationIcon({ state }: { state: RegistrationState }): React.ReactNode {
  switch (state) {
    case 'current':
      return <Loader2 className="w-5 h-5 animate-spin text-yappr-500" />
    case 'success':
      return <CheckCircle2 className="w-5 h-5 text-green-500" />
    case 'failed':
      return <XCircle className="w-5 h-5 text-red-500" />
    case 'pending':
      return <div className="w-5 h-5 rounded-full border-2 border-surface-200" />
  }
}

function RegistrationStatusText({ state }: { state: RegistrationState }): React.ReactNode {
  switch (state) {
    case 'current':
      return 'Registering...'
    case 'success':
      return 'Done'
    case 'failed':
      return <span className="text-red-500">Failed</span>
    case 'pending':
      return 'Pending'
  }
}

export function RegisteringStep(): React.ReactNode {
  const { usernames, currentRegistrationIndex } = useDpnsRegistration()

  const availableUsernames = usernames.filter(
    (u) => u.status === 'available' || u.status === 'contested'
  )

  const total = availableUsernames.length
  const displayIndex = total === 0 ? 0 : Math.min(currentRegistrationIndex + 1, total)

  return (
    <div className="space-y-6">
      <div className="text-center">
        <Loader2 className="w-12 h-12 animate-spin text-yappr-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Registering Usernames</h2>
        <p className="text-surface-500 dark:text-surface-400">
          Registering {displayIndex} of {total}...
        </p>
      </div>

      <div className="space-y-2">
        {availableUsernames.map((entry, index) => {
          const state = getRegistrationState(index, currentRegistrationIndex, entry)

          return (
            <div
              key={entry.id}
              className={cn('flex items-center gap-3 p-3 rounded-lg border', getRowStyles(state))}
            >
              <div className="flex-shrink-0">
                <RegistrationIcon state={state} />
              </div>
              <div className="flex-1">
                <code className="text-sm">{entry.label}.dash</code>
                {entry.isContested && (
                  <span className="ml-2 text-xs text-orange-600">(contested)</span>
                )}
              </div>
              <div className="text-sm text-gray-500">
                <RegistrationStatusText state={state} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
