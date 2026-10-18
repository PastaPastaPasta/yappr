import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Post' }

export default function PostLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
