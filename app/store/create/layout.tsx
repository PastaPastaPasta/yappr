import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Create a store' }

export default function StoreCreateLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
