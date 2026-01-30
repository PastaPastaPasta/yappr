import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from 'react-hot-toast'
import { Providers } from '@/components/providers'
import ErrorBoundary from '@/components/error-boundary'
import { DevelopmentBanner } from '@/components/ui/development-banner'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'
import { LoginModal } from '@/components/auth/login-modal'
import { LinkPreviewModalProvider } from '@/components/post/link-preview'

const basePath = process.env.BASE_PATH || ''

// CDN URL for the evo-sdk - loaded dynamically for better performance
const EVO_SDK_CDN_URL = 'https://cdn.jsdelivr.net/npm/@dashevo/evo-sdk@3.0.0/dist/evo-sdk.module.js'

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
        {/* Preload the evo-sdk from CDN for faster initial load */}
        <link
          rel="modulepreload"
          href={EVO_SDK_CDN_URL}
          crossOrigin="anonymous"
        />
      </head>
      <body className="font-sans h-full bg-white dark:bg-neutral-900">
        <ErrorBoundary level="app">
          <Providers>
            <LinkPreviewModalProvider>
              <DevelopmentBanner />
              <div className="h-[32px] sm:h-[40px]" /> {/* Spacer for fixed banner */}
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
              background: '#1f2937',
              color: '#fff',
              borderRadius: '8px',
              padding: '12px 16px',
              fontSize: '14px',
            },
          }}
        />
      </body>
    </html>
  )
}