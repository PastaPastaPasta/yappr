'use client'

import { Fragment, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useAppStore } from '@/lib/store'
import { NetworkPill } from '@/components/layout/network-pill'
import { SkipLink } from '@/components/layout/skip-link'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { ComposeModal } from '@/components/compose/compose-modal'
import { ElectionBannerFrame } from '@/components/moderation/election-banner'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'
import { ModeratorViewBar, ModeratorViewController, ModeratorViewHold } from '@/components/moderation/moderator-view'
import { useModeratorViewHolding } from '@/hooks/use-moderator-view'

/**
 * The page, mounted afresh whenever the viewer changes on it (a sign-in, an
 * account switch or a sign-out that keeps the page), so no card or hook keeps
 * the previous viewer's likes, reposts or bookmarks. Restoring a saved session
 * at load is not a change.
 */
function ViewerScope({ children }: { children: React.ReactNode }) {
  const { user, isAuthRestoring } = useAuth()
  const viewer = user?.identityId ?? null
  const [scope, setScope] = useState<{ viewer: string | null; key: number } | null>(null)
  if (!isAuthRestoring && scope?.viewer !== viewer) {
    // A card's hand-off to the thread page carries the previous viewer's state.
    if (scope) useAppStore.setState({ pendingPostNavigation: null })
    setScope({ viewer, key: scope ? scope.key + 1 : 0 })
  }
  return <Fragment key={scope?.key ?? 0}>{children}</Fragment>
}

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
          <ElectionBannerFrame><ViewerScope>{children}</ViewerScope></ElectionBannerFrame>
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
