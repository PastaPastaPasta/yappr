import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Followers' }

export default function FollowersLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
