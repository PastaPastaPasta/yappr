import type { Metadata } from 'next'
import { SdkWasmPreload } from '@/components/sdk-wasm-preload'

export const metadata: Metadata = { title: 'Profile' }

export default function UserLayout({ children }: { children: React.ReactNode }) {
  return <><SdkWasmPreload />{children}</>
}
