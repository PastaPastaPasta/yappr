#!/usr/bin/env node
/**
 * Build the engine bundle for one network variant.
 *
 *   node mobile/engine/build.mjs --variant testnet|devnet [--sourcemap] [--outdir dir]
 *
 * Outputs (default `mobile/engine/dist/<variant>/`):
 *   engine.js           the IIFE bundle: evo-sdk (wasm inlined, gzip+base64), lib/, the API
 *   engine.html         loads engine.js from the same directory (file:// or a custom base URL)
 *   engine.inline.html  the same with engine.js inlined, for `source={{ html, baseUrl }}`
 *   selftest.html       engine + an in-page host that runs boot/feed/post/profile and prints timings
 *   manifest.json       sha256, sizes, versions, network wiring
 *   meta.json           esbuild metafile (inspect with https://esbuild.github.io/analyze/)
 *
 * Env: the `testnet` variant uses NO env file, exactly like the production web
 * build (`npm run build`), so lib/constants.ts falls back to its testnet
 * defaults. `devnet` reads `.env.devnet`, as `npm run build:devnet` does.
 * Only NEXT_PUBLIC_* keys are inlined, as Next.js does.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const VARIANTS = {
  testnet: { envFile: null },
  devnet: { envFile: '.env.devnet' },
}

function parseArgs(argv) {
  const args = { variant: 'testnet', sourcemap: false, outdir: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--variant') args.variant = argv[++i]
    else if (arg === '--sourcemap') args.sourcemap = true
    else if (arg === '--outdir') args.outdir = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!(args.variant in VARIANTS)) throw new Error(`Unknown variant ${args.variant}; expected ${Object.keys(VARIANTS).join(', ')}`)
  return args
}

/** KEY=VALUE lines; `#` comments; optional single or double quotes. No expansion (the files use none). */
export function parseEnvFile(text) {
  const env = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

/** The `process.env.*` values the bundle sees for a variant. */
export function variantEnv(variant) {
  const { envFile } = VARIANTS[variant]
  const fileEnv = envFile ? parseEnvFile(readFileSync(path.join(root, envFile), 'utf8')) : {}
  const env = Object.fromEntries(Object.entries(fileEnv).filter(([key]) => key.startsWith('NEXT_PUBLIC_')))
  return {
    ...env,
    NODE_ENV: 'production',
    // next.config.js derives these from BASE_PATH. The app has no base path,
    // and each network gets its own host-side storage namespace, so keys keep
    // their unscoped names.
    NEXT_PUBLIC_BASE_PATH: '',
    NEXT_PUBLIC_STORAGE_SCOPE: '',
  }
}

/** `@/x` → `<repo>/x`, for files outside lib's own tsconfig too. */
const rootAliasPlugin = {
  name: 'root-alias',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\// }, args =>
      pluginBuild.resolve(`./${args.path.slice(2)}`, { kind: args.kind, resolveDir: root }))
  },
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outdir = path.resolve(args.outdir ?? path.join(here, 'dist', args.variant))
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })

  const env = variantEnv(args.variant)
  const evoSdkVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/@dashevo/evo-sdk/package.json'), 'utf8')).version
  const engineBuild = { variant: args.variant, evoSdkVersion, builtAt: new Date().toISOString() }

  const define = {
    __ENGINE_BUILD__: JSON.stringify(engineBuild),
    // Anything not listed reads as undefined, as in a Next.js client bundle.
    'process.env': '{}',
    global: 'globalThis',
  }
  for (const [key, value] of Object.entries(env)) define[`process.env.${key}`] = JSON.stringify(value)

  const started = Date.now()
  const result = await build({
    entryPoints: [path.join(here, 'src/entry.webview.ts')],
    outfile: path.join(outdir, 'engine.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // DecompressionStream (the inlined wasm is gzip) needs iOS 16.4 / Chrome 80.
    target: ['safari16.4', 'chrome110'],
    minify: true,
    sourcemap: args.sourcemap ? 'linked' : false,
    legalComments: 'none',
    metafile: true,
    define,
    plugins: [rootAliasPlugin],
    logLevel: 'warning',
  })
  const buildMs = Date.now() - started

  const js = readFileSync(path.join(outdir, 'engine.js'))
  const hash = sha256(js)
  const hashScript = `<script>globalThis.__YAPPR_ENGINE_BUNDLE_HASH__=${JSON.stringify(hash)}</script>`
  const head = `<!doctype html><html><head><meta charset="utf-8"><title>yappr engine</title>${hashScript}`
  writeFileSync(path.join(outdir, 'engine.html'), `${head}<script src="engine.js"></script></head><body></body></html>\n`)
  writeFileSync(path.join(outdir, 'engine.inline.html'), `${head}<script>${js}</script></head><body></body></html>\n`)
  writeFileSync(path.join(outdir, 'meta.json'), JSON.stringify(result.metafile))

  // Diagnostics page: an in-page host for browsers nothing can drive (see src/selftest.ts).
  await build({
    entryPoints: [path.join(here, 'src/selftest.ts')],
    outfile: path.join(outdir, 'selftest.js'),
    bundle: true, format: 'iife', platform: 'browser', target: ['safari16.4', 'chrome110'], minify: true, logLevel: 'warning',
  })
  writeFileSync(path.join(outdir, 'selftest.html'), `${head}<meta name="viewport" content="width=device-width"></head><body><pre id="out" style="white-space:pre-wrap;font:14px monospace"></pre><script src="selftest.js"></script><script src="engine.js"></script></body></html>\n`)

  const manifest = {
    ...engineBuild,
    sha256: hash,
    bytes: js.length,
    gzipBytes: gzipSync(js).length,
    buildMs,
    network: env.NEXT_PUBLIC_NETWORK ?? 'testnet (default)',
    contractId: env.NEXT_PUBLIC_YAPPR_CONTRACT_ID ?? 'lib/constants default',
    topology: env.NEXT_PUBLIC_CONTRACT_TOPOLOGY ?? 'v2 (default)',
    env,
  }
  writeFileSync(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const top = Object.entries(result.metafile.inputs)
    .map(([file, { bytes }]) => [file, bytes])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  console.log(`engine ${args.variant}: ${(js.length / 1e6).toFixed(2)} MB (${(manifest.gzipBytes / 1e6).toFixed(2)} MB gzip), sha256 ${hash.slice(0, 12)}, ${buildMs} ms → ${path.relative(process.cwd(), outdir)}`)
  for (const [file, bytes] of top) console.log(`  ${(bytes / 1e6).toFixed(2)} MB  ${file}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
