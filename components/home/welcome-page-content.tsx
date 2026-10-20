'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import { PoweredByDash, Wordmark } from '@/components/brand/brand'
import { PageShell } from '@/components/layout/page-shell'
import { LegalLinks } from '@/components/layout/legal-links'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useHomepageData } from '@/hooks/use-homepage-data'
import { PlatformStats, FeaturedPosts, TopUsersSection } from '@/components/home'
import { useLoginModal } from '@/hooks/use-login-modal'

interface WelcomePageContentProps {
  /** Send a logged-in viewer to their feed instead of showing the landing page. */
  redirectAuthenticated?: boolean
}

/**
 * The landing page: hero, a row of platform counts, popular posts and top
 * contributors. It uses the app's columns: everything but the contributors
 * sits in the centre column, the contributors in the right rail (under the
 * posts below `lg`). Everything on it reads without an account. Rendered at `/`
 * (bouncing logged-in viewers to `/feed`) and at `/welcome` (never bouncing,
 * so the sidebar logo can always reach it).
 */
export function WelcomePageContent({ redirectAuthenticated = false }: WelcomePageContentProps) {
  const router = useRouter()
  const { user } = useAuth()
  const openLoginModal = useLoginModal((s) => s.open)
  const { platformStats, featuredPosts, topUsers, refresh } = useHomepageData({ skipSignedIn: redirectAuthenticated })

  // Auth state comes from local storage, so the first client render can
  // differ from the static HTML; hold the sign-in button's place until hydrated.
  const [isHydrated, setIsHydrated] = useState(false)
  useEffect(() => setIsHydrated(true), [])

  useEffect(() => {
    if (redirectAuthenticated && user) router.push('/feed')
  }, [redirectAuthenticated, user, router])

  const topContributors = (
    <TopUsersSection users={topUsers.users} loading={topUsers.loading} error={topUsers.error} />
  )

  return (
    <PageShell rightSidebar={topContributors}>
      <section className="px-4 pb-8 pt-10 text-center md:pb-10 md:pt-14">
        <h1 className="mb-4 text-3xl font-bold md:text-5xl">
          Welcome to <Wordmark />
        </h1>
        <div className="mb-4 flex justify-center">
          <PoweredByDash />
        </div>
        <p className="mx-auto mb-6 max-w-xl px-2 text-base text-gray-600 dark:text-gray-400 md:mb-8 md:text-xl">
          Social media you own. Your name and your posts belong to you.
        </p>

        <div className="flex flex-col justify-center gap-3 px-4 sm:flex-row sm:gap-4 sm:px-0">
          {!isHydrated ? (
            <div className="h-12 w-full rounded-full bg-gray-200 dark:bg-gray-800 sm:w-40" aria-hidden="true" />
          ) : user ? (
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
            <Link href="/feed">Browse Posts</Link>
          </Button>
        </div>
      </section>

      <div className="px-4">
        <PlatformStats
          totalPosts={platformStats.totalPosts}
          authorCount={platformStats.authorCount}
          authorCountCapped={platformStats.authorCountCapped}
          postsToday={platformStats.postsToday}
          loading={platformStats.loading}
          error={platformStats.error}
        />
      </div>

      <div className="pb-12">
        <FeaturedPosts
          posts={featuredPosts.posts}
          loading={featuredPosts.loading}
          error={featuredPosts.error}
          onRetry={refresh}
        />
      </div>

      {/* The right rail carries these from `lg` up. */}
      <div className="px-4 pb-12 lg:hidden">{topContributors}</div>

      {/* From tablet width up the sidebar carries these links. */}
      <footer className="px-4 pb-8 md:hidden">
        <LegalLinks />
      </footer>
    </PageShell>
  )
}
