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
      <div className="min-h-[calc(100vh-40px)] flex bg-surface-50 dark:bg-surface-950">
        {/* Sidebar skeleton - hidden on mobile */}
        <div className="hidden md:block fixed h-[calc(100vh-40px)] w-[275px] px-2 py-4 top-[40px]">
          <div className="h-8 w-20 bg-surface-200 dark:bg-surface-800 rounded mb-6 animate-pulse" />
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 bg-surface-100 dark:bg-surface-900 rounded-full animate-pulse" />
            ))}
          </div>
          <div className="mt-8 h-12 bg-surface-200 dark:bg-surface-800 rounded-full animate-pulse" />
        </div>

        {/* Main content skeleton */}
        <main className="flex-1 md:max-w-[1200px] mx-auto px-4 md:px-8 py-8 md:py-16">
          <div className="text-center mb-8 md:mb-16">
            <div className="h-10 md:h-16 w-full max-w-72 md:max-w-96 bg-surface-200 dark:bg-surface-800 rounded mx-auto mb-4 animate-pulse" />
            <div className="h-5 md:h-6 w-full max-w-[300px] md:max-w-[500px] bg-surface-100 dark:bg-surface-900 rounded mx-auto mb-6 md:mb-8 animate-pulse" />
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <div className="h-12 w-full sm:w-32 bg-surface-200 dark:bg-surface-800 rounded animate-pulse" />
              <div className="h-12 w-full sm:w-32 bg-surface-100 dark:bg-surface-900 rounded animate-pulse" />
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex bg-surface-50 dark:bg-surface-950">
      <Sidebar />

      <main className="flex-1 md:max-w-[1200px] mx-auto px-4 md:px-8 overflow-x-hidden">
        {/* Hero Section */}
        <section className="relative overflow-hidden py-12 md:py-20 text-center">
          {/* Atmospheric gradient background */}
          <div className="absolute inset-0 bg-gradient-mesh opacity-60 pointer-events-none" />

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="relative"
          >
            <h1 className="font-display text-4xl md:text-6xl lg:text-7xl font-bold mb-6 tracking-tight">
              Welcome to <span className="text-gradient-warm">Yappr</span>
            </h1>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="relative"
          >
            <div className="flex justify-center mb-6">
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
            <p className="text-lg md:text-xl text-surface-500 dark:text-surface-400 mb-8 md:mb-10 max-w-2xl mx-auto px-2 leading-relaxed">
              The decentralized social platform where you own your data, your identity, and your voice.
              Built on Dash Platform.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="relative"
          >
            {/* Decorative glow behind CTA */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 -z-10 w-64 h-64 bg-yappr-500/10 dark:bg-yappr-500/5 rounded-full blur-3xl" />

            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <Button size="lg" className="shadow-yappr-lg text-base px-8 py-3" onClick={openLoginModal}>
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
        <section className="py-16 text-center border-t border-surface-200/60 dark:border-surface-800/40">
          <div className="gradient-border">
            <div className="bg-surface-50 dark:bg-surface-900 rounded-3xl p-12">
              <h2 className="font-display text-3xl md:text-4xl font-bold mb-4">Ready to join the conversation?</h2>
              <p className="text-lg text-surface-500 dark:text-surface-400 mb-8">
                Create your decentralized identity and start sharing your thoughts.
              </p>
              <Button size="lg" className="shadow-yappr-lg" onClick={openLoginModal}>
                Create Account
                <ArrowRightIcon className="ml-2 h-5 w-5" />
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
