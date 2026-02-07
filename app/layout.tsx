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
  description: 'A modern social platform for sharing thoughts and connecting with others',
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
      <body className="font-sans h-full bg-white dark:bg-surface-950 text-gray-900 dark:text-gray-100 antialiased">
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
              background: '#0f172a',
              color: '#f8fafc',
              borderRadius: '12px',
              padding: '12px 20px',
              fontSize: '14px',
              border: '1px solid rgba(59, 124, 248, 0.1)',
              boxShadow: '0 8px 32px -8px rgba(0, 0, 0, 0.3)',
            },
          }}
        />
      </body>
    </html>
  )
}
