import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Orders' }

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
