import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import base from '../components/vite.config'
const mocks = fileURLToPath(new URL('./qa-round1-mocks.tsx', import.meta.url))
const boundaries = [
  '@/lib/feed/prove-absent',
  '@/hooks/use-post-enrichment', '@/lib/services/reply-service',
  '@/lib/services/social-stats-service', '@/hooks/use-profile-tabs', '@/hooks/use-block', '@/hooks/use-moderated-type-open',
  '@/components/profile/profile-tabs', '@/components/profile/yapp-flow', '@/components/dpns/username-modal',
  '@/components/ui/payment-qr-dialog', '@/components/settings/avatar-customization', '@/components/settings/banner-customization',
  'next/navigation', '@/contexts/auth-context', '@/contexts/sdk-context', '@/components/layout/sidebar',
  '@/components/layout/right-sidebar', '@/components/layout/page-shell', '@/components/messages/messages-v5', '@/components/messages/legacy-messages',
  '@/lib/services/store-service', '@/lib/services/store-item-service', '@/lib/services/shipping-zone-service',
  '@/lib/services/store-stats-service', '@/lib/services/store-order-service', '@/lib/services/store-review-service',
  '@/lib/services/identity-service', '@/lib/services/cart-service', '@/lib/services/saved-address-service',
  '@/lib/services/private-feed-reads', '@/lib/services/post-service', '@/lib/services/dpns-service',
  '@/lib/services/unified-profile-service', '@/lib/services', '@/lib/crypto/encryption-key-lookup',
  '@/lib/utils/resolve-user-details', '@/hooks/use-post-detail', '@/hooks/use-progressive-enrichment',
  '@/hooks/use-can-reply-to-private', '@/hooks/use-infinite-scroll', '@/components/post/post-card',
  '@/components/post/post-tips', '@/components/post/reply-thread', '@/components/ui/payment-qr-code',
  '@/components/profile/private-feed-access-button', '@/components/dpns/username-dropdown',
  '@/components/moderation/barred-writer-notice', '@/components/messages/use-user-search', '@/components/moderation/contract-report-button', '@/components/moderation/moderator-content-menu',
]
const aliases = boundaries.map(find => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement: mocks }))
export default defineConfig({ ...base, root: fileURLToPath(new URL('./', import.meta.url)), resolve: { ...base.resolve, alias: [...aliases, ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] }, define: { 'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_DM_TOPOLOGY: 'v5', NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID: 'offline-fixture', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v10', NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v17', NEXT_PUBLIC_NETWORK: 'testnet', NEXT_PUBLIC_STORAGE_SCOPE: 'qa-regression' }) }, optimizeDeps: { entries: ['qa-round1.html'] } })
