#!/usr/bin/env node
// Deliberately opt-in: ordinary builds keep their current configuration until
// package.json's build switches to `npm run build:release` in the cut-over PR.
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import releaseConfig from './release-config.cjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const file = fileURLToPath(new URL('../.env.testnet', import.meta.url))
let configured
try {
  configured = parseEnv(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`Cannot load .env.testnet: ${error.message}\nCopy .env.testnet.template and complete docs/TESTNET_DEPLOY.md first.`)
  process.exit(1)
}
// Public config is authoritative, including explicit blanks. BASE_PATH remains
// a call-site choice. Do not inherit stray public keys from a CI dashboard.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NEXT_PUBLIC_')))
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
process.exit(result.status ?? 1)
