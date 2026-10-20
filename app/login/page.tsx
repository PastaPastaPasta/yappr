'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Lockup } from '@/components/brand/brand'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'

export default function LoginPage() {
  const router = useRouter()
  const { user } = useAuth()
  const { open } = useLoginModal()

  // Open the login modal when this page loads
  useEffect(() => {
    if (!user) {
      open()
    }
  }, [user, open])

  // Redirect if already logged in
  useEffect(() => {
    if (user) {
      router.push('/feed')
    }
  }, [user, router])

  // This page just renders the background - the modal is global
  return (
    <main className="min-h-[calc(100vh-64px)] md:min-h-screen bg-white dark:bg-neutral-900 flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-2xl">
        <h1 className="mb-6 flex justify-center"><Lockup height={96} className="max-w-full h-auto" /></h1>
        <p className="text-xl md:text-2xl text-gray-600 dark:text-gray-400 mb-8">
          Decentralized social media on Dash Platform
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center text-sm text-gray-500 dark:text-gray-500">
          <span>You hold your keys</span>
          <span className="hidden sm:inline">·</span>
          <span>Chronological or ranked feeds</span>
          <span className="hidden sm:inline">·</span>
          <span>Moderated in the open</span>
        </div>
      </div>
    </main>
  )
}
