'use client'

import { Button } from '@/components/ui/button'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { CheckCircle2, AlertTriangle, XCircle, PartyPopper } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CompleteStepProps {
  onRegisterMore: () => void
  onContinue: () => void
}

export function CompleteStep({ onRegisterMore, onContinue }: CompleteStepProps) {
  const { usernames } = useDpnsRegistration()

  const registeredUsernames = usernames.filter((u) => u.registered === true)
  const failedUsernames = usernames.filter(
    (u) => u.registered === false && u.registrationError
  )
  const contestedRegistered = registeredUsernames.filter((u) => u.isContested)

  const getStatusIcon = (entry: typeof usernames[0]) => {
    if (entry.registered && entry.isContested) {
      return <AlertTriangle className="w-5 h-5 text-orange-500" />
    }
    if (entry.registered) {
      return <CheckCircle2 className="w-5 h-5 text-green-500" />
    }
    return <XCircle className="w-5 h-5 text-red-500" />
  }

  const getStatusText = (entry: typeof usernames[0]) => {
    if (entry.registered && entry.isContested) {
      return 'Registered (awaiting voting)'
    }
    if (entry.registered) {
      return 'Registered'
    }
    return entry.registrationError || 'Failed'
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        {registeredUsernames.length > 0 ? (
          <>
            <PartyPopper className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Registration Complete</h2>
          </>
        ) : (
          <>
            <XCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Registration Failed</h2>
          </>
        )}
        <p className="text-gray-600 dark:text-gray-400">
          {registeredUsernames.length} succeeded, {failedUsernames.length} failed
          {contestedRegistered.length > 0 &&
            `, ${contestedRegistered.length} awaiting voting`}
        </p>
      </div>

      {/* Results table */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Username
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {usernames
              .filter((u) => u.registered !== undefined)
              .map((entry) => (
                <tr key={entry.id}>
                  <td className="px-4 py-3">
                    <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                      {entry.label}.dash
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(entry)}
                      <span
                        className={cn(
                          'text-sm',
                          entry.registered && !entry.isContested && 'text-green-600',
                          entry.registered && entry.isContested && 'text-orange-600',
                          !entry.registered && 'text-red-600'
                        )}
                      >
                        {getStatusText(entry)}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onRegisterMore} className="flex-1">
          Register More Usernames
        </Button>
        <Button onClick={onContinue} className="flex-1">
          Continue
        </Button>
      </div>
    </div>
  )
}
