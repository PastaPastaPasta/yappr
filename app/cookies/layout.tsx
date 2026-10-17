import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Cookie policy' }

export default function CookiesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
