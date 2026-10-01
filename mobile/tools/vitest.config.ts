import { defineConfig } from 'vitest/config'

// Unit tests only: no network, no pool file. The live path is exercised by
// running the responder itself (README.md).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
