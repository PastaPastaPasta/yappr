import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Data contract' }

export default function ContractLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
