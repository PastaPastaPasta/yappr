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
          <div className="h-8 w-20 skeleton mb-6" />
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 skeleton rounded-xl" />
            ))}
          </div>
          <div className="mt-8 h-12 skeleton rounded-full" />
        </div>

        {/* Main content skeleton */}
        <main className="flex-1 md:max-w-[1200px] mx-auto px-4 md:px-8 py-8 md:py-16">
          <div className="text-center mb-8 md:mb-16">
            <div className="h-10 md:h-16 w-full max-w-72 md:max-w-96 skeleton mx-auto mb-4" />
            <div className="h-5 md:h-6 w-full max-w-[300px] md:max-w-[500px] skeleton mx-auto mb-6 md:mb-8" />
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <div className="h-12 w-full sm:w-32 skeleton rounded-full" />
              <div className="h-12 w-full sm:w-32 skeleton rounded-full" />
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
        <section className="py-12 md:py-20 text-center relative">
          {/* Background glow decoration */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-gradient-to-r from-yappr-500/5 via-accent-500/5 to-transparent rounded-full blur-3xl" />
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="relative"
          >
            <h1 className="text-4xl md:text-6xl font-display font-bold mb-5 tracking-tight">
              Welcome to <span className="text-gradient">Yappr</span>
            </h1>
            <div className="flex justify-center mb-5">
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
            <p className="text-base md:text-lg text-gray-500 dark:text-gray-400 mb-8 md:mb-10 max-w-2xl mx-auto px-2 leading-relaxed">
              The decentralized social platform where you own your data, your identity, and your voice.
              Built on Dash Platform.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <Button size="lg" onClick={openLoginModal}>
                Get Started
                <ArrowRightIcon className="h-5 w-5" />
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
        <section className="py-16 md:py-20 text-center border-t border-border">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-4 tracking-tight">Ready to join the conversation?</h2>
          <p className="text-lg text-gray-500 dark:text-gray-400 mb-8">
            Create your decentralized identity and start sharing your thoughts.
          </p>
          <Button size="lg" onClick={openLoginModal}>
            Create Account
            <ArrowRightIcon className="ml-1 h-5 w-5" />
          </Button>
        </section>
      </main>
    </div>
  )
}
