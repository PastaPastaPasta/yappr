import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Following' }

export default function FollowingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
