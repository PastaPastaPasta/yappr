'use client'

import { usePathname } from 'next/navigation'
import { DevelopmentBanner } from '@/components/ui/development-banner'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (pathname.startsWith('/embed')) {
    return <>{children}</>
  }

  return (
    <LinkPreviewModalProvider>
      <DevelopmentBanner />
      <div className="h-[32px] sm:h-[40px]" />
      {children}
      <div className="h-16 md:hidden" />
      <MobileBottomNav />
      <LoginModal />
    </LinkPreviewModalProvider>
  )
}
