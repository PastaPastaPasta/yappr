import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Cookies and storage' }

export default function CookiesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
