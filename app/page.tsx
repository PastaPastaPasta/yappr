'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { motion } from 'framer-motion'
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import Link from 'next/link'
import { useHomepageData } from '@/hooks/use-homepage-data'
import { PlatformStats, FeaturedPosts, TopUsersSection } from '@/components/home'
import { useLoginModal } from '@/hooks/use-login-modal'

export default function PublicHomePage() {
  const router = useRouter()
  const { user } = useAuth()
  const [isHydrated, setIsHydrated] = useState(false)
  const openLoginModal = useLoginModal((s) => s.open)

  const { platformStats, featuredPosts, topUsers, refresh } = useHomepageData()

  // Prevent hydration mismatches
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Redirect authenticated users to feed
  useEffect(() => {
    if (user) {
      router.push('/feed')
    }
  }, [user, router])

  // Show loading skeleton during hydration
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

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <main className="flex-1 md:max-w-[1200px] mx-auto px-4 md:px-8 overflow-x-hidden">
        {/* Hero Section */}
        <section className="py-8 md:py-16 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-4xl md:text-6xl font-display font-bold mb-4 tracking-tight">
              Welcome to <span className="text-gradient">yappr</span>
            </h1>
            <div className="flex justify-center mb-4">
              <Image
                src="/pbde-light.png"
                alt="Powered by Dash Evolution"
                width={240}
                height={80}
                className="dark:hidden"
              />
              <Image
                src="/pbde-dark.png"
                alt="Powered by Dash Evolution"
                width={240}
                height={80}
                className="hidden dark:block"
              />
            </div>
            <p className="text-base md:text-xl text-gray-500 dark:text-gray-400 mb-6 md:mb-8 max-w-2xl mx-auto px-2 leading-relaxed">
              The decentralized social platform where you own your data, your identity, and your voice.
              Built on Dash Platform.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <Button size="lg" className="shadow-yappr-lg" onClick={openLoginModal}>
                Get Started
                <ArrowRightIcon className="ml-2 h-5 w-5" />
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/feed">
                  Explore Public Posts
                </Link>
              </Button>
            </div>
          </motion.div>
        </section>

        {/* Platform Stats Section */}
        <PlatformStats
          totalPosts={platformStats.totalPosts}
          totalUsers={platformStats.totalUsers}
          loading={platformStats.loading}
          error={platformStats.error}
          onRetry={refresh}
        />

        {/* Top Contributors Section */}
        <TopUsersSection
          users={topUsers.users}
          loading={topUsers.loading}
          error={topUsers.error}
          onRetry={refresh}
        />

        {/* Featured Posts Section */}
        <FeaturedPosts
          posts={featuredPosts.posts}
          loading={featuredPosts.loading}
          error={featuredPosts.error}
          onRetry={refresh}
        />

        {/* CTA Section */}
        <section className="py-16 text-center border-t border-gray-200 dark:border-gray-800">
          <h2 className="text-3xl font-display font-bold mb-4 tracking-tight">Ready to join the conversation?</h2>
          <p className="text-lg text-gray-500 dark:text-gray-400 mb-8">
            Create your decentralized identity and start sharing your thoughts.
          </p>
          <Button size="lg" className="shadow-yappr-lg" onClick={openLoginModal}>
            Create Account
            <ArrowRightIcon className="ml-2 h-5 w-5" />
          </Button>
        </section>
      </main>
    </div>
  )
}
