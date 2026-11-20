'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Lockup } from '@/components/brand/brand'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'
import { releaseWalletSignInReturn } from '@/lib/app-connect/pending-request'
import { afterSignInRoute, currentReturnToParam } from '@/lib/auth/return-to'

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

  // Signed in: on to the page that sent the visitor here; without one, a wallet
  // sign-in goes to the page its own request started from, else the feed.
  // Once per signed-in identity, so a later profile update can't redirect again.
  const identityId = user?.identityId
  useEffect(() => {
    if (!identityId) return
    router.replace(afterSignInRoute(currentReturnToParam(), identityId, releaseWalletSignInReturn()))
  }, [identityId, router])

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
