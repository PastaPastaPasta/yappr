import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Bookmarks' }

export default function BookmarksLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
