import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const mocks = fromHere('./mocks.tsx')
const exact = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
const services = ['dpns-service', 'identity-service', 'moderation-service', 'moderation-election-service']

// The /staging build's social v20 cut (.env.testnet), with every chain read replaced by mocks.tsx.
export default defineConfig({
  root: fromHere('./'),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      ...['next/navigation', '@/contexts/auth-context', '@/contexts/sdk-context'].map((name) => ({ find: exact(name), replacement: mocks })),
      ...services.map((name) => ({ find: exact(`@/lib/services/${name}`), replacement: fromHere(`./boundaries/${name}.ts`) })),
      { find: '@', replacement: fromHere('../../') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  define: {
    'process.env': JSON.stringify({
      NODE_ENV: 'test',
      NEXT_PUBLIC_NETWORK: 'testnet',
      NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v20',
      NEXT_PUBLIC_YAPPR_CONTRACT_ID: '63JuBhMjZKyBVJzj7ubCmGEacPsa8VtvgQomMsVrd36D',
      NEXT_PUBLIC_BLOG_TOPOLOGY: 'v11',
      NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v12',
      NEXT_PUBLIC_DM_TOPOLOGY: 'v5',
      NEXT_PUBLIC_STORAGE_SCOPE: 'staging-component-test',
    }),
  },
  server: { host: '127.0.0.1', fs: { allow: [fromHere('../../')] } },
  optimizeDeps: { entries: ['index.html'] },
})
