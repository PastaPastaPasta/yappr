'use client'

import { useState, useEffect } from 'react'
import { WelcomePageContent } from '@/components/home'

export default function WelcomePage() {
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  if (!isHydrated) {
    return (
      <div className="min-h-[calc(100vh-40px)] flex">
        {/* Sidebar skeleton - hidden on mobile */}
        <div className="hidden md:block fixed h-[calc(100vh-40px)] w-[275px] px-2 py-4 top-[40px]">
          <div className="h-8 w-20 bg-gray-200 dark:bg-gray-800 rounded mb-6 animate-pulse" />
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 dark:bg-gray-900 rounded-full animate-pulse" />
            ))}
          </div>
          <div className="mt-8 h-12 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
        </div>

        {/* Main content skeleton */}
        <main className="flex-1 md:max-w-[1200px] mx-auto px-4 md:px-8 py-8 md:py-16">
          <div className="text-center mb-8 md:mb-16">
            <div className="h-10 md:h-16 w-full max-w-72 md:max-w-96 bg-gray-200 dark:bg-gray-800 rounded mx-auto mb-4 animate-pulse" />
            <div className="h-5 md:h-6 w-full max-w-[300px] md:max-w-[500px] bg-gray-100 dark:bg-gray-900 rounded mx-auto mb-6 md:mb-8 animate-pulse" />
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <div className="h-12 w-full sm:w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-12 w-full sm:w-32 bg-gray-100 dark:bg-gray-900 rounded animate-pulse" />
            </div>
          </div>
        </main>
      </div>
    )
  }

  return <WelcomePageContent />
}
