import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Manage store' }

export default function StoreManageLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
