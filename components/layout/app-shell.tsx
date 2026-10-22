'use client'

import { usePathname } from 'next/navigation'
import { NetworkPill } from '@/components/layout/network-pill'
import { SkipLink } from '@/components/layout/skip-link'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { ComposeModal } from '@/components/compose/compose-modal'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'
import { ModeratorViewBar, ModeratorViewController } from '@/components/moderation/moderator-view'
import { Spinner } from '@/components/ui/spinner'
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
        <div className="flex min-h-screen items-center justify-center"><Spinner size="md" /></div>
      ) : (
        <LinkPreviewModalProvider>
          <SkipLink />
          <NetworkPill />
          {children}
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
