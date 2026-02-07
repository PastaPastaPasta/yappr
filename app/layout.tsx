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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans h-full">
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
              background: 'hsl(240, 22%, 7%)',
              color: '#e8e8f0',
              borderRadius: '12px',
              padding: '12px 16px',
              fontSize: '14px',
              border: '1px solid hsl(240, 15%, 16%)',
              boxShadow: '0 4px 30px -4px rgba(6, 182, 212, 0.15)',
            },
          }}
        />
      </body>
    </html>
  )
}
