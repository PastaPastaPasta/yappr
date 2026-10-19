import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import base from './qa-round1-vite.config'
const mocks = fileURLToPath(new URL('./tqa-mocks.tsx', import.meta.url))
const oldMocks = fileURLToPath(new URL('./qa-round1-mocks.tsx', import.meta.url))
const extra = ['@/lib/services/reply-service', '@/lib/feed/resolve-quoted-posts', '@/hooks/use-post-enrichment', '@/lib/services/bookmark-service', '@/hooks/use-blog-follow', '@/components/blog/blog-comments', '@/lib/services/item-review-service']
export default defineConfig({ ...base, resolve: { ...base.resolve, alias: [
  { find: /^\.\/blog-comments$/, replacement: mocks },
  ...extra.map(find => ({ find, replacement: mocks })),
  ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : []).map(alias => alias.replacement === oldMocks ? { ...alias, replacement: mocks } : alias),
] }, define: { 'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_BLOG_TOPOLOGY: 'v9', NEXT_PUBLIC_DM_TOPOLOGY: 'v5', NEXT_PUBLIC_CONTRACT_TOPOLOGY: process.env.TQA_SOCIAL_TOPOLOGY ?? 'v17', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v10', NEXT_PUBLIC_NETWORK: 'testnet', NEXT_PUBLIC_STORAGE_SCOPE: 'testnet-qa-regression' }) }, optimizeDeps: { entries: ['tqa.html'] } })
