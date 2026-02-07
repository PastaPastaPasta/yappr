'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'

export default function LoginPage() {
  const router = useRouter()
  const { user } = useAuth()
  const { open, isOpen } = useLoginModal()

  // Open the login modal when this page loads
  useEffect(() => {
    if (!user && !isOpen) {
      open()
    }
  }, [user, isOpen, open])

  // Redirect if already logged in
  useEffect(() => {
    if (user) {
      router.push('/feed')
    }
  }, [user, router])

  // This page just renders the background - the modal is global
  return (
    <div className="min-h-[calc(100vh-104px)] md:min-h-[calc(100vh-40px)] bg-white dark:bg-surface-900 flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-2xl">
        <h1 className="text-6xl md:text-8xl font-bold text-gradient mb-6">Yappr</h1>
        <p className="text-xl md:text-2xl text-gray-600 dark:text-gray-400 mb-8">
          Decentralized social media on Dash Platform
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center text-sm text-gray-500 dark:text-gray-500">
          <span>Own your data</span>
          <span className="hidden sm:inline">·</span>
          <span>No algorithms</span>
          <span className="hidden sm:inline">·</span>
          <span>Censorship resistant</span>
        </div>
      </div>
    </div>
  )
}
