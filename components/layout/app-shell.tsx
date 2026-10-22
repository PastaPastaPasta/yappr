'use client'

import { Fragment } from 'react'
import { usePathname } from 'next/navigation'
import { NetworkPill } from '@/components/layout/network-pill'
import { SkipLink } from '@/components/layout/skip-link'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { ComposeModal } from '@/components/compose/compose-modal'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'
import { ModeratorViewBar, ModeratorViewController } from '@/components/moderation/moderator-view'
import { Spinner } from '@/components/ui/spinner'
import { useModeratorViewStore } from '@/hooks/use-moderator-view'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // The moderator view changed what every listing reads: mount the page afresh so each reads again.
  const moderatorViewGeneration = useModeratorViewStore((state) => state.generation)
  // A moderator who left it on in this tab: hold the page until their seats are read, so it loads once.
  const awaitingSeats = useModeratorViewStore((state) => state.enabled && state.viewer !== null && state.seatedFor !== state.viewer)

  if (pathname === '/embed' || pathname.startsWith('/embed/')) {
    return <>{children}</>
  }

  return (
    <LinkPreviewModalProvider>
      <ModeratorViewController />
      <SkipLink />
      <NetworkPill />
      {awaitingSeats
        ? <div className="flex min-h-screen items-center justify-center"><Spinner size="md" /></div>
        : <Fragment key={moderatorViewGeneration}>{children}</Fragment>}
      <div className="h-16 md:hidden" />
      <MobileBottomNav />
      <LoginModal />
      <ComposeModal />
      <ModeratorViewBar />
    </LinkPreviewModalProvider>
  )
}
