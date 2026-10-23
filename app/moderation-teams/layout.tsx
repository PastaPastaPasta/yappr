import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Moderation teams' }

export default function ModerationTeamsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
