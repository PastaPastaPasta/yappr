import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Sales' }

export default function SellerOrdersLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
