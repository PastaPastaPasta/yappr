'use client'

import { Loader2 } from 'lucide-react'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'

export function CheckingStep() {
  const { usernames } = useDpnsRegistration()
  const validUsernames = usernames.filter((u) => u.label.trim() && u.status !== 'invalid')

  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-4">
      <Loader2 className="w-12 h-12 animate-spin text-purple-600" />
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">Checking Availability</h2>
        <p className="text-gray-600 dark:text-gray-400">
          Checking {validUsernames.length} username{validUsernames.length !== 1 ? 's' : ''}...
        </p>
      </div>
    </div>
  )
}
