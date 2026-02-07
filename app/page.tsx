'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { motion } from 'framer-motion'
import { ArrowRightIcon, SparklesIcon } from '@heroicons/react/24/outline'
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
        <div className="hidden md:block fixed h-[calc(100vh-40px)] w-[260px] px-3 py-4 top-[40px]">
          <div className="h-8 w-20 bg-zinc-200 dark:bg-zinc-800 rounded-lg mb-6 animate-pulse" />
          <div className="space-y-1.5">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-10 bg-zinc-100 dark:bg-zinc-800/50 rounded-xl animate-pulse" />
            ))}
          </div>
          <div className="mt-6 h-11 bg-zinc-200 dark:bg-zinc-800 rounded-xl animate-pulse" />
        </div>

        {/* Main content skeleton */}
        <main className="flex-1 md:max-w-[1200px] mx-auto px-4 md:px-8 py-8 md:py-16">
          <div className="text-center mb-8 md:mb-16">
            <div className="h-10 md:h-16 w-full max-w-72 md:max-w-96 bg-zinc-200 dark:bg-zinc-800 rounded-xl mx-auto mb-4 animate-pulse" />
            <div className="h-5 md:h-6 w-full max-w-[300px] md:max-w-[500px] bg-zinc-100 dark:bg-zinc-800/50 rounded-lg mx-auto mb-6 md:mb-8 animate-pulse" />
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <div className="h-12 w-full sm:w-36 bg-zinc-200 dark:bg-zinc-800 rounded-xl animate-pulse" />
              <div className="h-12 w-full sm:w-36 bg-zinc-100 dark:bg-zinc-800/50 rounded-xl animate-pulse" />
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
          {/* Subtle background glow */}
          <div className="absolute inset-0 -z-10 overflow-hidden">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-yappr-500/5 rounded-full blur-3xl" />
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-yappr-500/10 text-yappr-600 dark:text-yappr-400 text-sm font-medium mb-6">
              <SparklesIcon className="h-4 w-4" />
              Decentralized Social
            </div>

            <h1 className="text-4xl md:text-6xl font-extrabold mb-5 tracking-tight">
              Welcome to <span className="text-gradient">Yappr</span>
            </h1>
            <div className="flex justify-center mb-5">
              <Image
                src="/pbde-light.png"
                alt="Powered by Dash Evolution"
                width={200}
                height={67}
                className="dark:hidden opacity-60"
              />
              <Image
                src="/pbde-dark.png"
                alt="Powered by Dash Evolution"
                width={200}
                height={67}
                className="hidden dark:block opacity-60"
              />
            </div>
            <p className="text-base md:text-lg text-zinc-600 dark:text-zinc-400 mb-8 md:mb-10 max-w-xl mx-auto px-2 leading-relaxed">
              The decentralized social platform where you own your data, your identity, and your voice.
              Built on Dash Platform.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              <Button size="lg" className="shadow-yappr-lg text-base" onClick={openLoginModal}>
                Get Started
                <ArrowRightIcon className="ml-1 h-5 w-5" />
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
        <section className="py-16 md:py-20 text-center border-t border-zinc-200/60 dark:border-zinc-800/40">
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="text-2xl md:text-3xl font-bold mb-3 tracking-tight">Ready to join the conversation?</h2>
            <p className="text-base text-zinc-600 dark:text-zinc-400 mb-8 max-w-md mx-auto">
              Create your decentralized identity and start sharing your thoughts.
            </p>
            <Button size="lg" className="shadow-yappr-lg" onClick={openLoginModal}>
              Create Account
              <ArrowRightIcon className="ml-1 h-5 w-5" />
            </Button>
          </motion.div>
        </section>
      </main>
    </div>
  )
}
