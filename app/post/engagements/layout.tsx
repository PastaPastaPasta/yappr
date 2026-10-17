import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Post activity' }

export default function PostEngagementsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
