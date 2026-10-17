import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Store' }

export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
