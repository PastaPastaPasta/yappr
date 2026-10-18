#!/usr/bin/env node
// Older master Pages workflows also build the staging checkout with `build`.
// Keep that entry point on the rehearsal set without changing the root build.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const staging = process.env.BASE_PATH === '/staging'
const result = spawnSync(process.execPath, staging
  ? [fileURLToPath(new URL('./build-release.mjs', import.meta.url)), '.env.staging']
  : [fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)), 'build'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
})
if (result.error) console.error(result.error.message)
if (result.status !== 0) process.exit(result.status ?? 1)
if (!staging) {
  const fallback = spawnSync(process.execPath, [fileURLToPath(new URL('./write-static-404.mjs', import.meta.url)), 'out'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
  })
  if (fallback.error) console.error(fallback.error.message)
  if (fallback.status !== 0) process.exit(fallback.status ?? 1)
}
