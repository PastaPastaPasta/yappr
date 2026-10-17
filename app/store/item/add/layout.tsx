import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Add a product' }

export default function StoreItemAddLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
