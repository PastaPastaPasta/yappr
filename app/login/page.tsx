'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Lockup } from '@/components/brand/brand'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'
import { useUsernameModal } from '@/hooks/use-username-modal'
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

  // Signed in: on to the page that sent the visitor here, or the feed. Once per
  // signed-in identity, so a later profile update can't redirect again. Not while
  // the username prompt is open: its Skip and Continue follow this page's `next`.
  const identityId = user?.identityId
  const usernamePromptOpen = useUsernameModal((state) => state.isOpen)
  useEffect(() => {
    if (!identityId || usernamePromptOpen) return
    router.replace(returnToOrDefault(currentReturnToParam()))
  }, [identityId, usernamePromptOpen, router])

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
