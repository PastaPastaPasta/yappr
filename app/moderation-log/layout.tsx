import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Moderation log' }

export default function ModerationLogLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
