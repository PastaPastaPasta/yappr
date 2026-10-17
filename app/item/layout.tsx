import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Item' }

export default function ItemLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
