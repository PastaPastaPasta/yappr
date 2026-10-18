#!/usr/bin/env node
// Deliberately opt-in: ordinary builds keep their current configuration until
// package.json's build switches to `npm run build:release` in the cut-over PR.
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadReleaseEnv } from './release-config.cjs'
import { staticNotFound } from './write-static-404.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const envFile = process.argv[2] ?? '.env.testnet'
if (!['.env.testnet', '.env.staging'].includes(envFile) || process.argv.length > 3) {
  console.error('Usage: build-release.mjs [.env.testnet|.env.staging]')
  process.exit(1)
}
const file = fileURLToPath(new URL(`../${envFile}`, import.meta.url))
let env
try {
  env = loadReleaseEnv(file)
  if (envFile === '.env.staging') {
    if (env.BASE_PATH !== '/staging' || env.NEXT_PUBLIC_NETWORK !== 'testnet') {
      throw new Error('The staging rehearsal requires BASE_PATH=/staging and NETWORK=testnet')
    }
    env.YAPPR_STAGING_REHEARSAL = '1'
  }
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
