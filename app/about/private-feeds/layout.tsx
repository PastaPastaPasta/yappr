import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Private feeds' }

export default function PrivateFeedsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
