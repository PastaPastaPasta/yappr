import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from 'react-hot-toast'
import { Providers } from '@/components/providers'
import ErrorBoundary from '@/components/error-boundary'
import { DevelopmentBanner } from '@/components/ui/development-banner'
import { TestnetDowntimeBanner } from '@/components/ui/testnet-downtime-banner'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'

const basePath = process.env.BASE_PATH || ''

export const metadata: Metadata = {
  title: 'Yappr - Share Your Voice',
  description: 'The decentralized social platform where you own your voice',
  icons: {
    icon: `${basePath}/yappr.jpg`,
    apple: `${basePath}/yappr.jpg`,
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="font-sans h-full bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-50 antialiased">
        <ErrorBoundary level="app">
          <Providers>
            <LinkPreviewModalProvider>
              <DevelopmentBanner />
              <TestnetDowntimeBanner />
              <div className="h-[64px] sm:h-[80px]" /> {/* Spacer for fixed banners */}
              <ErrorBoundary level="page">
                {children}
              </ErrorBoundary>
              <div className="h-16 md:hidden" /> {/* Spacer for mobile bottom nav */}
              <MobileBottomNav />
              <LoginModal />
            </LinkPreviewModalProvider>
          </Providers>
        </ErrorBoundary>
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 3000,
            style: {
              background: '#18181b',
              color: '#fafafa',
              borderRadius: '10px',
              padding: '12px 16px',
              fontSize: '14px',
              fontFamily: 'Space Grotesk, -apple-system, sans-serif',
            },
          }}
        />
      </body>
    </html>
  )
}