import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from 'react-hot-toast'
import { Providers } from '@/components/providers'
import ErrorBoundary from '@/components/error-boundary'
import { DevelopmentBanner } from '@/components/ui/development-banner'
import { MobileBottomNav } from '@/components/layout/mobile-bottom-nav'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Yappr - Share Your Voice',
  description: 'A modern social platform for sharing thoughts and connecting with others',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} h-full bg-white dark:bg-black`}>
        <ErrorBoundary level="app">
          <Providers>
            <DevelopmentBanner />
            <div className="h-[40px]" /> {/* Spacer for fixed banner */}
            <ErrorBoundary level="page">
              {children}
            </ErrorBoundary>
            <div className="h-16 md:hidden" /> {/* Spacer for mobile bottom nav */}
            <MobileBottomNav />
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