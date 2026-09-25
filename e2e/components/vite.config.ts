import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const mocks = fromHere('./private-feed-mocks.ts')

export default defineConfig({
  root: fromHere('./'),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      { find: /^@\/contexts\/auth-context$/, replacement: mocks },
      { find: /^@\/lib\/services$/, replacement: mocks },
      { find: /^@\/lib\/services\/identity-service$/, replacement: mocks },
      { find: /^@\/lib\/crypto\/key-validation$/, replacement: mocks },
      { find: /^@\/hooks\/use-encryption-key-modal$/, replacement: mocks },
      { find: /^\.\/reset-private-feed-dialog$/, replacement: mocks },
      { find: /^@\/components\/auth\/add-encryption-key-modal$/, replacement: mocks },
      { find: '@', replacement: fromHere('../../') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  define: {
    'process.env': JSON.stringify({
      NODE_ENV: 'test',
      NEXT_PUBLIC_NETWORK: 'testnet',
      NEXT_PUBLIC_STORAGE_SCOPE: 'component-test',
    }),
  },
  server: { host: '127.0.0.1', fs: { allow: [fromHere('../../')] } },
})
