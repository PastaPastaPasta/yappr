'use client'

import Image from 'next/image'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useHomepageData } from '@/hooks/use-homepage-data'
import { PlatformStats, FeaturedPosts, TopUsersSection } from '@/components/home'
import { useLoginModal } from '@/hooks/use-login-modal'

export function WelcomePageContent() {
  const { user } = useAuth()
  const openLoginModal = useLoginModal((s) => s.open)
  const { platformStats, featuredPosts, topUsers, refresh } = useHomepageData()

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
            <h1 className="text-3xl md:text-5xl font-bold mb-4">
              Welcome to <span className="text-gradient">Yappr</span>
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
            <p className="text-base md:text-xl text-gray-600 dark:text-gray-400 mb-6 md:mb-8 max-w-2xl mx-auto px-2">
              The decentralized social platform where you own your data, your identity, and your voice.
              Built on Dash Platform.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4 sm:px-0">
              {user ? (
                <Button size="lg" className="shadow-yappr-lg" asChild>
                  <Link href="/feed">
                    Go to Feed
                    <ArrowRightIcon className="ml-2 h-5 w-5" />
                  </Link>
                </Button>
              ) : (
                <Button size="lg" className="shadow-yappr-lg" onClick={openLoginModal}>
                  Get Started
                  <ArrowRightIcon className="ml-2 h-5 w-5" />
                </Button>
              )}
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
          {user ? (
            <Button size="lg" className="shadow-yappr-lg" asChild>
              <Link href="/feed">
                Go to Feed
                <ArrowRightIcon className="ml-2 h-5 w-5" />
              </Link>
            </Button>
          ) : (
            <Button size="lg" className="shadow-yappr-lg" onClick={openLoginModal}>
              Create Account
              <ArrowRightIcon className="ml-2 h-5 w-5" />
            </Button>
          )}
        </section>
      </main>
    </div>
  )
}
