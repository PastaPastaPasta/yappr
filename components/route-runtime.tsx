'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { ThemeProvider } from 'next-themes'
import { isStaticRoute } from '@/lib/static-routes'
import { NetworkPill } from '@/components/layout/network-pill'
import { SkipLink } from '@/components/layout/skip-link'

const AppRuntime = dynamic(() => import('./app-runtime'))

export function RouteRuntime({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [runtimeLoaded, setRuntimeLoaded] = useState(() => !isStaticRoute(pathname))
  if (!runtimeLoaded && !isStaticRoute(pathname)) setRuntimeLoaded(true)
  if (runtimeLoaded || !isStaticRoute(pathname)) return <AppRuntime>{children}</AppRuntime>
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SkipLink />
      <NetworkPill />
      {children}
    </ThemeProvider>
  )
}
