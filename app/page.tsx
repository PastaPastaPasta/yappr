'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import Link from 'next/link'
import { useHomepageData } from '@/hooks/use-homepage-data'
import { PlatformStats, FeaturedPosts, TopUsersSection } from '@/components/home'

export default function PublicHomePage() {
  const router = useRouter()
  const { user } = useAuth()
  const [isHydrated, setIsHydrated] = useState(false)

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
        {/* Sidebar skeleton */}
        <div className="fixed h-[calc(100vh-40px)] w-[275px] px-2 py-4 top-[40px]">
          <div className="h-8 w-20 bg-gray-200 dark:bg-gray-800 rounded mb-6 animate-pulse" />
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 dark:bg-gray-900 rounded-full animate-pulse" />
            ))}
          </div>
          <div className="mt-8 h-12 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
        </div>

        {/* Main content skeleton */}
        <main className="flex-1 max-w-[1200px] mx-auto px-8 py-16">
          <div className="text-center mb-16">
            <div className="h-16 w-96 bg-gray-200 dark:bg-gray-800 rounded mx-auto mb-4 animate-pulse" />
            <div className="h-6 w-[500px] bg-gray-100 dark:bg-gray-900 rounded mx-auto mb-8 animate-pulse" />
            <div className="flex gap-4 justify-center">
              <div className="h-12 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              <div className="h-12 w-32 bg-gray-100 dark:bg-gray-900 rounded animate-pulse" />
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <main className="flex-1 max-w-[1200px] mx-auto px-8">
        {/* Hero Section */}
        <section className="py-16 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-5xl font-bold mb-4">
              Welcome to <span className="text-gradient">Yappr</span>
            </h1>
            <p className="text-xl text-gray-600 dark:text-gray-400 mb-8 max-w-2xl mx-auto">
              The decentralized social platform where you own your data, your identity, and your voice.
              Built on Dash Platform.
            </p>

            <div className="flex gap-4 justify-center">
              <Button size="lg" asChild className="shadow-yappr-lg">
                <Link href="/login">
                  Get Started
                  <ArrowRightIcon className="ml-2 h-5 w-5" />
                </Link>
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
          <h2 className="text-3xl font-bold mb-4">Ready to join the conversation?</h2>
          <p className="text-lg text-gray-600 dark:text-gray-400 mb-8">
            Create your decentralized identity and start sharing your thoughts.
          </p>
          <Button size="lg" asChild className="shadow-yappr-lg">
            <Link href="/login">
              Create Account
              <ArrowRightIcon className="ml-2 h-5 w-5" />
            </Link>
          </Button>
        </section>
      </main>
    </div>
  )
}
