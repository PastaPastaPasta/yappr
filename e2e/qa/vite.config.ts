import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
const path = (value: string) => fileURLToPath(new URL(value, import.meta.url))
const mocks = path('./mocks.tsx')
export default defineConfig({
  root: path('./'), esbuild: { jsx: 'automatic' },
  resolve: { alias: [
    { find: '@/hooks/use-moderation-authorization', replacement: mocks },
    ...['components/layout/page-shell', 'lib/services/follow-service', 'lib/services/unified-profile-service', 'lib/services/social-stats-service', 'lib/services/identity-batch', 'lib/services/moderation-service', 'components/moderation/charter-reason-picker', 'components/moderation/contract-report-queue', 'components/moderation/report-queue', 'components/moderation/team-actions-panel', 'contexts/auth-context', 'contexts/sdk-context', 'lib/services/moderation-election-service', 'lib/services/blog-follow-service', 'hooks/use-blog-follow', 'lib/services', 'lib/services/key-validation-service', 'lib/services/identity-service', 'lib/services/dpns-service', 'lib/auth/passkey-vault', 'hooks/use-moderated-type-open', 'components/ui/profile-image-upload', 'components/moderation/barred-writer-notice'].map((name) => ({ find: new RegExp('^@/' + name + '$'), replacement: mocks })),
    { find: '@', replacement: path('../../') },
  ], dedupe: ['react', 'react-dom'] },
  define: { 'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_NETWORK: 'devnet', NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v17', NEXT_PUBLIC_BLOG_TOPOLOGY: 'v9', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v10', NEXT_PUBLIC_STORAGE_SCOPE: 'qa-offline' }) },
  server: { host: '127.0.0.1', fs: { allow: [path('../../')] } },
})
