import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Toaster } from 'react-hot-toast'
import { RouteRuntime } from '@/components/route-runtime'
import ErrorBoundary from '@/components/error-boundary'
import { FrameGuard } from '@/components/layout/frame-guard'
import { APP_URL } from '@/lib/constants'
import { monitoringContractConfig } from '@/lib/monitoring-contract-config'
import { IMG_SRC, MEDIA_SRC } from '@/lib/media/media-csp'

const basePath = process.env.BASE_PATH || ''
const description = 'Social media you own. Your identity and posts live on Dash Platform.'

export const metadata: Metadata = {
  metadataBase: new URL(`${APP_URL}${basePath}/`),
  title: { default: 'Yappr', template: '%s · Yappr' },
  description,
  applicationName: 'Yappr',
  manifest: `${basePath}/manifest.webmanifest`,
  icons: {
    icon: [
      { url: `${basePath}/favicon.ico`, sizes: '32x32' },
      { url: `${basePath}/icon-192.png`, type: 'image/png', sizes: '192x192' },
    ],
    apple: `${basePath}/icon-192.png`,
  },
  openGraph: {
    type: 'website',
    siteName: 'Yappr',
    title: 'Yappr',
    description,
    images: [{ url: 'og-image.jpg', width: 1200, height: 630, alt: 'Yappr: social media you own' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Yappr',
    description,
    images: ['og-image.jpg'],
  },
  // Only the production build at the site root is indexed; /staging, /testing
  // and /devnet are copies of it on other contracts (public/robots.txt too).
  robots: basePath ? { index: false, follow: false } : undefined,
}

export const viewport: Viewport = {
  themeColor: '#0ea5e9',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <meta name="yappr-contract-config" content={JSON.stringify(monitoringContractConfig)} />
        <meta
          httpEquiv="Content-Security-Policy"
          content={`default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src ${IMG_SRC}; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https: wss: https://44.240.98.102:1443; worker-src 'self' blob:; child-src 'self' blob:; media-src ${MEDIA_SRC}; frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com`}
        />
      </head>
      <body className="font-sans h-full bg-white dark:bg-neutral-900">
        <FrameGuard basePath={basePath}>
          <ErrorBoundary level="app">
            <RouteRuntime>
              <ErrorBoundary level="page">
                {children}
              </ErrorBoundary>
            </RouteRuntime>
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
        </FrameGuard>
      </body>
    </html>
  )
}
