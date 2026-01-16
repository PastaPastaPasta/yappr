'use client'

import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { cn } from '@/lib/utils'

export function RegisteringStep() {
  const { usernames, currentRegistrationIndex } = useDpnsRegistration()

  const availableUsernames = usernames.filter(
    (u) => u.status === 'available' || u.status === 'contested'
  )

  // Clamp display values to avoid showing "N+1 of N" or "1 of 0"
  const total = availableUsernames.length
  const displayIndex = total === 0 ? 0 : Math.min(currentRegistrationIndex + 1, total)

  return (
    <div className="space-y-6">
      <div className="text-center">
        <Loader2 className="w-12 h-12 animate-spin text-purple-600 mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Registering Usernames</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Registering {displayIndex} of {total}...
        </p>
      </div>

      <div className="space-y-2">
        {availableUsernames.map((entry, index) => {
          const isCurrentOrDone = index <= currentRegistrationIndex
          const isCurrent = index === currentRegistrationIndex
          const isDone = index < currentRegistrationIndex
          const hasFailed = entry.registrationError

          return (
            <div
              key={entry.id}
              className={cn(
                'flex items-center gap-3 p-3 rounded-lg border',
                isCurrent && 'border-purple-500 bg-purple-50 dark:bg-purple-900/20',
                isDone && !hasFailed && 'border-green-500 bg-green-50 dark:bg-green-900/20',
                isDone && hasFailed && 'border-red-500 bg-red-50 dark:bg-red-900/20',
                !isCurrentOrDone && 'border-gray-200 dark:border-gray-700 opacity-50'
              )}
            >
              <div className="flex-shrink-0">
                {isCurrent && <Loader2 className="w-5 h-5 animate-spin text-purple-600" />}
                {isDone && !hasFailed && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                {isDone && hasFailed && <XCircle className="w-5 h-5 text-red-500" />}
                {!isCurrentOrDone && (
                  <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
                )}
              </div>
              <div className="flex-1">
                <code className="text-sm">{entry.label}.dash</code>
                {entry.isContested && (
                  <span className="ml-2 text-xs text-orange-600">(contested)</span>
                )}
              </div>
              <div className="text-sm text-gray-500">
                {isCurrent && 'Registering...'}
                {isDone && !hasFailed && 'Done'}
                {isDone && hasFailed && (
                  <span className="text-red-500">Failed</span>
                )}
                {!isCurrentOrDone && 'Pending'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
