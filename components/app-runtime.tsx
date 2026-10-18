'use client'

import { Providers } from '@/components/providers'
import { AppShell } from '@/components/layout/app-shell'

export default function AppRuntime({ children }: { children: React.ReactNode }) {
  return <Providers><AppShell>{children}</AppShell></Providers>
}
