'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'

/**
 * Usernames for wallet sign-ins: Yappr's wallet keys cannot register names,
 * so the user picks one in their Dash wallet and comes back.
 */
export function WalletUsernameGuide({ onComplete, onSkip, additional = false }: { onComplete: () => void; onSkip: () => void; additional?: boolean }) {
  const { controller, refreshDpnsUsernames, user } = useAuth()
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      await refreshDpnsUsernames()
      if (additional) toast.success('Usernames refreshed. New registrations can take a minute to show up.')
      else if (!controller.getState().user?.username) toast('No username yet. It can take a minute to show up.')
    } catch (error) {
      logger.warn('Username refresh failed:', error)
    } finally {
      setChecking(false)
    }
  }

  if (user?.dpnsUsername && !additional) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-gray-700 dark:text-gray-300">You&apos;re all set as @{user.dpnsUsername.replace(/\.dash$/, '')}.</p>
        <Button className="w-full" onClick={onComplete}>Continue</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-gray-700 dark:text-gray-300">
        {additional ? 'Register another username in your Dash wallet. Your existing usernames will keep working.' : 'Pick your username in your Dash wallet. Once it’s registered, come back here.'}
      </p>
      <Button
        className="w-full"
        disabled={checking}
        onClick={() => {
          check().catch(() => undefined)
        }}
      >
        {checking ? 'Checking…' : additional ? 'Refresh usernames' : 'I\'ve registered one'}
      </Button>
      <Button variant="ghost" className="w-full" onClick={onSkip}>Not now</Button>
    </div>
  )
}
