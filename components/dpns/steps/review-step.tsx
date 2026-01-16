'use client'

import { Button } from '@/components/ui/button'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ReviewStepProps {
  onBack: () => void
  onRegister: () => void
}

export function ReviewStep({ onBack, onRegister }: ReviewStepProps) {
  const {
    usernames,
    contestedAcknowledged,
    setContestedAcknowledged,
  } = useDpnsRegistration()

  const availableUsernames = usernames.filter(
    (u) => u.status === 'available' || u.status === 'contested'
  )
  const nonContestedUsernames = usernames.filter((u) => u.status === 'available')
  const contestedUsernames = usernames.filter((u) => u.status === 'contested')

  // Only show warning if ALL available usernames are contested (no non-contested options)
  const allContestedWarning = availableUsernames.length > 0 && nonContestedUsernames.length === 0
  const canProceed = availableUsernames.length > 0 && (!allContestedWarning || contestedAcknowledged)

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'available':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />
      case 'contested':
        return <AlertTriangle className="w-5 h-5 text-orange-500" />
      default:
        return <XCircle className="w-5 h-5 text-red-500" />
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'available':
        return 'Available'
      case 'contested':
        return 'Contested'
      case 'taken':
        return 'Taken'
      case 'invalid':
        return 'Invalid'
      default:
        return 'Unknown'
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-2">Review Usernames</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {availableUsernames.length} of {usernames.length} username
          {usernames.length !== 1 ? 's' : ''} can be registered.
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
              .filter((u) => u.label.trim())
              .map((entry) => (
                <tr key={entry.id}>
                  <td className="px-4 py-3">
                    <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                      {entry.label}.dash
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(entry.status)}
                      <span
                        className={cn(
                          'text-sm',
                          entry.status === 'available' && 'text-green-600',
                          entry.status === 'contested' && 'text-orange-600',
                          (entry.status === 'taken' || entry.status === 'invalid') &&
                            'text-red-600'
                        )}
                      >
                        {getStatusText(entry.status)}
                      </span>
                      {entry.status === 'contested' && (
                        <span
                          title="Contested usernames require masternode voting. Your username won't appear on Yappr until voting completes."
                          className="cursor-help"
                        >
                          <Info className="w-4 h-4 text-orange-400" />
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Contested warning - only shown when ALL usernames are contested */}
      {allContestedWarning && (
        <div className="border-2 border-orange-400 bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-orange-500 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-orange-800 dark:text-orange-200">
                Contested Username{contestedUsernames.length > 1 ? 's' : ''} Only
              </h3>
              <p className="text-sm text-orange-700 dark:text-orange-300 mt-2">
                All of your usernames are <strong>contested</strong>, which means they require
                masternode voting before they can be granted to you.
              </p>
              <p className="text-sm text-orange-700 dark:text-orange-300 mt-2">
                <strong>Until voting completes, your username will not appear on Yappr</strong> and
                your identity ID will be shown instead. Consider adding a non-contested username
                (20+ characters, or containing digits 2-9) if you want your name visible right away.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={contestedAcknowledged}
              onChange={(e) => setContestedAcknowledged(e.target.checked)}
              className="w-4 h-4 rounded border-orange-400 text-orange-600 focus:ring-orange-500"
            />
            <span className="text-sm text-orange-800 dark:text-orange-200">
              I understand my username won&apos;t be available until voting completes
            </span>
          </label>
        </div>
      )}

      {availableUsernames.length === 0 && (
        <div className="text-center py-4 text-gray-600 dark:text-gray-400">
          No usernames available to register. Please go back and try different usernames.
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="flex-1">
          Back to Edit
        </Button>
        <Button onClick={onRegister} disabled={!canProceed} className="flex-1">
          Register {availableUsernames.length} Username
          {availableUsernames.length !== 1 ? 's' : ''}
        </Button>
      </div>
    </div>
  )
}
