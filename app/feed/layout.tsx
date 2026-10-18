import type { Metadata } from 'next'
import { SdkWasmPreload } from '@/components/sdk-wasm-preload'

export const metadata: Metadata = { title: 'Home' }

export default function FeedLayout({ children }: { children: React.ReactNode }) {
  return <><SdkWasmPreload />{children}</>
}
