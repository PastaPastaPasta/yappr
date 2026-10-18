#!/usr/bin/env node
// Deliberately opt-in: ordinary builds keep their current configuration until
// package.json's build switches to `npm run build:release` in the cut-over PR.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import releaseConfig from './release-config.cjs'
import { staticNotFound } from './write-static-404.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const file = fileURLToPath(new URL('../.env.testnet', import.meta.url))
let configured
try {
  configured = parseEnv(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`Cannot load .env.testnet: ${error.message}\nCopy .env.testnet.template and complete docs/TESTNET_DEPLOY.md first.`)
  process.exit(1)
}
// Release config is authoritative, including explicit blanks. BASE_PATH remains
// a call-site choice. Public keys and the epoch must come from the release file.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('NEXT_PUBLIC_') && key !== 'STORAGE_EPOCH'))
Object.assign(env, configured, { NEXT_PUBLIC_RELEASE: '1' })
try {
  releaseConfig.assertReleaseConfig(env)
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
