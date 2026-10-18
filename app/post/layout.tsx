import type { Metadata } from 'next'
import { SdkWasmPreload } from '@/components/sdk-wasm-preload'

export const metadata: Metadata = { title: 'Post' }

export default function PostLayout({ children }: { children: React.ReactNode }) {
  return <><SdkWasmPreload />{children}</>
}
