#!/usr/bin/env node
// `npm run build` (root, and /staging with BASE_PATH=/staging, per D20) builds
// from the checked-in public release pins in .env.testnet, never ambient values.
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadReleaseEnv } from './release-config.cjs'
import { staticNotFound } from './write-static-404.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
if (process.argv.length > 2) {
  console.error('Usage: build-release.mjs (it always builds from .env.testnet)')
  process.exit(1)
}
let env
try {
  env = loadReleaseEnv(fileURLToPath(new URL('../.env.testnet', import.meta.url)))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)), 'build'], {
  cwd: root, env, stdio: 'inherit',
})
if (result.error) console.error(result.error.message)
if (result.status !== 0) process.exit(result.status ?? 1)
writeFileSync(new URL('../out/404.html', import.meta.url), staticNotFound(env.BASE_PATH ?? ''))
