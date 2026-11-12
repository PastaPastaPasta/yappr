#!/usr/bin/env node
// `npm run build` (root, and /staging with BASE_PATH=/staging, per D20) builds
// from the checked-in public release pins in .env.testnet, never ambient values.
// --mainnet [env-file] builds from mainnet public pins (default .env.mainnet).
// A QA build passes its own env file instead (QA_BUILDS in release-config.cjs:
// `build:staging-old` and `build:beta`, the D36 rehearsal set's v17 and
// v18 members), served at its own base path with its own contract snapshot
// (next.config.js).
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { QA_BUILDS, loadReleaseEnv } from './release-config.cjs'
import { staticNotFound } from './write-static-404.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const mainnet = args[0] === '--mainnet'
const envFile = mainnet ? args[1] ?? '.env.mainnet' : args[0] ?? '.env.testnet'
const qaBuild = Object.keys(QA_BUILDS).find(name => QA_BUILDS[name].envFile === envFile) ?? null
if ((!mainnet && envFile !== '.env.testnet' && qaBuild === null) || args.length > (mainnet ? 2 : 1)) {
  console.error(`Usage: build-release.mjs [${['.env.testnet', ...Object.values(QA_BUILDS).map(build => build.envFile)].join('|')}] | --mainnet [env-file]`)
  process.exit(1)
}
let env
try {
  env = loadReleaseEnv(resolve(root, envFile), process.env, mainnet ? null : qaBuild, mainnet ? 'mainnet' : 'testnet')
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
