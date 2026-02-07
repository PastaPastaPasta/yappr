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
      <body className="font-sans h-full bg-surface-50 dark:bg-surface-950 text-gray-900 dark:text-gray-50">
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
              background: '#1A2035',
              color: '#F7F6F3',
              borderRadius: '12px',
              padding: '14px 18px',
              fontSize: '14px',
              border: '1px solid rgba(45, 53, 72, 0.5)',
              boxShadow: '0 10px 40px -10px rgba(0, 0, 0, 0.4)',
            },
          }}
        />
      </body>
    </html>
  )
}
