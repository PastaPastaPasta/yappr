import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Hashtag' }

export default function HashtagLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
