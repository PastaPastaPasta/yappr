import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Mentions' }

export default function MentionsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
