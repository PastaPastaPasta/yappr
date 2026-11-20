'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Lockup } from '@/components/brand/brand'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'
import { currentReturnToParam, returnToOrDefault } from '@/lib/auth/return-to'

export default function LoginPage() {
  const router = useRouter()
  const { user, isAuthRestoring } = useAuth()
  const { open } = useLoginModal()

  // Open the login modal once no saved session is coming back
  useEffect(() => {
    if (!user && !isAuthRestoring) {
      open()
    }
  }, [user, isAuthRestoring, open])

  // Already signed in on arrival: on to the page that sent the visitor here, or the
  // feed. A sign-in made here goes on through the auth context instead.
  const [arrivedSignedIn, setArrivedSignedIn] = useState<boolean | null>(null)
  if (arrivedSignedIn === null && !isAuthRestoring) setArrivedSignedIn(Boolean(user))
  useEffect(() => {
    if (arrivedSignedIn) router.replace(returnToOrDefault(currentReturnToParam()))
  }, [arrivedSignedIn, router])

  // This page just renders the background - the modal is global
  return (
    <main className="min-h-[calc(100vh-64px)] md:min-h-screen bg-white dark:bg-neutral-900 flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-2xl">
        <h1 className="mb-6 flex justify-center"><Lockup height={96} className="max-w-full h-auto" /></h1>
        <p className="text-xl md:text-2xl text-gray-600 dark:text-gray-400">
          Social media you own.
        </p>
      </div>
    </main>
  )
}
