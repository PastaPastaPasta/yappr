'use client'

import { usePathname } from 'next/navigation'
import { NetworkPill } from '@/components/layout/network-pill'
import { SkipLink } from '@/components/layout/skip-link'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { ComposeModal } from '@/components/compose/compose-modal'
import { ElectionBannerFrame } from '@/components/moderation/election-banner'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'
import { ModeratorViewBar, ModeratorViewController, ModeratorViewHold } from '@/components/moderation/moderator-view'
import { useModeratorViewHolding } from '@/hooks/use-moderator-view'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // The moderator view is on in this tab: nothing mounts (or reads) until it is applied.
  const holding = useModeratorViewHolding()

  if (pathname === '/embed' || pathname.startsWith('/embed/')) {
    return <>{children}</>
  }

  return (
    <>
      <ModeratorViewController />
      {holding ? (
        <ModeratorViewHold />
      ) : (
        <LinkPreviewModalProvider>
          <SkipLink />
          <NetworkPill />
          <ElectionBannerFrame>{children}</ElectionBannerFrame>
          <div className="h-16 md:hidden" />
          <MobileBottomNav />
          <LoginModal />
          <ComposeModal />
          <ModeratorViewBar />
        </LinkPreviewModalProvider>
      )}
    </>
  )
}
