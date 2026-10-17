'use client'

import { usePathname } from 'next/navigation'
import { NetworkPill } from '@/components/layout/network-pill'
import { SkipLink } from '@/components/layout/skip-link'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { ComposeModal } from '@/components/compose/compose-modal'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname === '/embed' || pathname.startsWith('/embed/')) {
    return <>{children}</>
  }

  return (
    <LinkPreviewModalProvider>
      <SkipLink />
      <NetworkPill />
      {children}
      <div className="h-16 md:hidden" />
      <MobileBottomNav />
      <LoginModal />
      <ComposeModal />
    </LinkPreviewModalProvider>
  )
}
