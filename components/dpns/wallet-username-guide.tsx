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
export function WalletUsernameGuide({ onComplete, onSkip }: { onComplete: () => void; onSkip: () => void }) {
  const { controller, refreshDpnsUsernames, user } = useAuth()
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      await refreshDpnsUsernames()
    } catch (error) {
      logger.warn('Username refresh failed:', error)
    } finally {
      setChecking(false)
    }
  }

  if (user?.dpnsUsername) {
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
        Pick your username in your Dash wallet. Once it&apos;s registered, come back here.
      </p>
      <Button
        className="w-full"
        disabled={checking}
        onClick={() => {
          check()
            .then(() => { if (!controller.getState().user?.username) toast('No username yet. It can take a minute to show up.') })
            .catch(() => undefined)
        }}
      >
        {checking ? 'Checking…' : 'I\'ve registered one'}
      </Button>
      <Button variant="ghost" className="w-full" onClick={onSkip}>Not now</Button>
    </div>
  )
}
