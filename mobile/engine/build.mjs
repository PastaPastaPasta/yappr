#!/usr/bin/env node
/**
 * Build the engine bundle for one network variant.
 *
 *   node mobile/engine/build.mjs --variant testnet|staging-testnet|devnet [--sourcemap] [--outdir dir] [--update-packages]
 *
 * Outputs (default `mobile/engine/dist/<variant>/`):
 *   engine.js           the IIFE bundle: evo-sdk and its wasm-bindgen glue, lib/, the API
 *   engine.wasm.js      the SDK's WASM, gzip + base64, as `window.__YAPPR_ENGINE_WASM__ = "…"`
 *   engine.avatars.js   the DiceBear styles, as `window.__YAPPR_ENGINE_AVATARS__`
 *   engine.html         loads the three, in that order, from the same directory (file:// or a custom base URL)
 *   engine.inline.html  the same with all three inlined, for `source={{ html, baseUrl }}`
 *   selftest.html       engine + an in-page host that runs boot/feed/post/profile and prints timings
 *   manifest.json       sha256, sizes, versions, network wiring
 *   meta.json           esbuild metafile (inspect with https://esbuild.github.io/analyze/)
 *
 * It also checks mobile/engine/bundled-packages.json (committed) against the
 * bundles; --update-packages rewrites it (see BUNDLED_PACKAGES).
 *
 * Env: release variants read .env.testnet / .env.staging through the web's
 * fail-closed release validator. Devnet reads .env.devnet. Only public keys
 * are inlined; ambient overrides cannot change a variant's pins.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ENGINE_ALIASES } from './aliases.mjs'
import buildConfig from './build-config.cjs'

const { VARIANTS, variantConfig } = buildConfig

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

function parseArgs(argv) {
  const args = { variant: 'testnet', sourcemap: false, outdir: null, updatePackages: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--variant') args.variant = argv[++i]
    else if (arg === '--sourcemap') args.sourcemap = true
    else if (arg === '--update-packages') args.updatePackages = true
    else if (arg === '--outdir') args.outdir = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!(args.variant in VARIANTS)) throw new Error(`Unknown variant ${args.variant}; expected ${Object.keys(VARIANTS).join(', ')}`)
  return args
}

/**
 * engine.js only: the DiceBear styles ship in engine.avatars.js (src/avatars/).
 * Not in ENGINE_ALIASES, so the Node harness draws avatars with the real ones.
 */
const BUNDLE_ALIASES = {
  ...ENGINE_ALIASES,
  '@dicebear/collection': path.join(here, 'src/avatars/collection-shim.ts'),
}

/** Module substitutions, each matching its exact specifier only (as vitest.config.ts does; esbuild's `alias` would also remap subpaths). */
function engineAliasPlugin(aliases) {
  const pattern = new RegExp(`^(${Object.keys(aliases).map(name => name.replace(/[/.]/g, '\\$&')).join('|')})$`)
  return {
    name: 'engine-alias',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: pattern }, args => ({ path: aliases[args.path] }))
    },
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

// esbuild expands the dynamic snapshot import before resolution; replace its JSON load.
const stagingSnapshotPlugin = {
  name: 'staging-contract-snapshot',
  setup(pluginBuild) {
    let replaced = false
    pluginBuild.onLoad({ filter: /[/\\]lib[/\\]contracts[/\\]bundled[/\\]testnet\.json$/ }, () => {
      replaced = true
      return { contents: readFileSync(path.join(root, 'lib/contracts/snapshots/testnet-staging.json'), 'utf8'), loader: 'json' }
    })
    pluginBuild.onEnd(() => {
      if (!replaced) throw new Error('The staging contract snapshot was not bundled')
    })
  },
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * Repo directories the bundle may read from. .github/workflows/mobile-engine.yml
 * watches the same set (plus the root manifests, tsconfig.json and
 * .env.devnet), so a change anywhere the engine reads triggers its CI.
 */
const WATCHED_INPUT_DIRS = ['mobile/engine/', 'lib/', 'types/', 'hooks/', 'vendor/platform-auth/', 'contracts/', 'node_modules/']

/** Fail when a metafile input lies outside WATCHED_INPUT_DIRS: CI would not rebuild on its changes. */
function assertInputsWatched(metafile) {
  const unwatched = Object.keys(metafile.inputs)
    .filter(input => !input.includes(':')) // esbuild-internal namespaces (`<define:…>`, etc.)
    .map(input => path.relative(root, path.resolve(process.cwd(), input)).split(path.sep).join('/'))
    .filter(file => !WATCHED_INPUT_DIRS.some(dir => file.startsWith(dir)))
  if (unwatched.length > 0) {
    throw new Error(`The bundle reads files the mobile-engine CI does not watch; add their directory to WATCHED_INPUT_DIRS and the workflow paths:\n  ${unwatched.join('\n  ')}`)
  }
}

/**
 * bundled-packages.json: the packages whose code the shipped scripts
 * (engine.js, engine.avatars.js) carry, as keys of the root package-lock.json.
 * The app's open-source licenses list (mobile/app/plugins/licenses) reads it,
 * so it lists what the app ships, not the web app's whole dependency tree.
 * Committed, so the app's checks need no engine build; this build fails when
 * it no longer matches the bundles.
 */
const BUNDLED_PACKAGES = path.join(here, 'bundled-packages.json')
/** `node_modules/a`, `node_modules/@s/a`, `node_modules/a/node_modules/b`: a package directory at the start of a path. */
const PACKAGE_DIR = /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+/

function bundledPackages(...metafiles) {
  const keys = new Set()
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      if (input.includes(':')) continue
      const match = PACKAGE_DIR.exec(path.relative(root, path.resolve(process.cwd(), input)).split(path.sep).join('/'))
      if (match) keys.add(match[0])
    }
  }
  return [...keys].sort()
}

function checkBundledPackages(packages, update) {
  const next = `${JSON.stringify({ description: 'Generated by mobile/engine/build.mjs: the packages engine.js and engine.avatars.js bundle (root package-lock.json keys), for the app\'s open-source licenses list.', packages }, null, 2)}\n`
  let current = null
  try {
    current = readFileSync(BUNDLED_PACKAGES, 'utf8')
  } catch {
    // Missing: written with --update-packages.
  }
  if (current === next) return
  if (!update) {
    throw new Error('The engine bundles a different set of packages than mobile/engine/bundled-packages.json lists. Rebuild with --update-packages, then run `npm run licenses` in mobile/app.')
  }
  writeFileSync(BUNDLED_PACKAGES, next)
  console.log('Updated bundled-packages.json; run `npm run licenses` in mobile/app.')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outdir = path.resolve(args.outdir ?? path.join(here, 'dist', args.variant))
  const config = variantConfig(root, args.variant)
  const { env } = config
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })

  const evoSdkVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/@dashevo/evo-sdk/package.json'), 'utf8')).version
  const engineBuild = { variant: args.variant, evoSdkVersion, builtAt: new Date().toISOString() }

  const define = {
    __ENGINE_BUILD__: JSON.stringify(engineBuild),
    // Anything not listed reads as undefined, as in a Next.js client bundle.
    'process.env': '{}',
    global: 'globalThis',
  }
  for (const [key, value] of Object.entries(env)) define[`process.env.${key}`] = JSON.stringify(value)

  const common = {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // DecompressionStream (the inlined wasm is gzip) needs iOS 16.4 / Chrome 80.
    target: ['safari16.4', 'chrome110'],
    minify: true,
    logLevel: 'warning',
  }

  const started = Date.now()
  const result = await build({
    ...common,
    entryPoints: [path.join(here, 'src/entry.webview.ts')],
    outfile: path.join(outdir, 'engine.js'),
    sourcemap: args.sourcemap ? 'linked' : false,
    legalComments: 'none',
    metafile: true,
    define,
    plugins: [engineAliasPlugin(BUNDLE_ALIASES), rootAliasPlugin, ...(args.variant === 'staging-testnet' ? [stagingSnapshotPlugin] : [])],
  })
  const buildMs = Date.now() - started
  assertInputsWatched(result.metafile)

  // The sidecar scripts (src/sidecar.ts), each one global assignment.
  // engine.avatars.js: the real DiceBear styles, which engine.js only stands in for.
  const avatars = await build({
    ...common,
    entryPoints: [path.join(here, 'src/avatars/entry.ts')],
    outfile: path.join(outdir, 'engine.avatars.js'),
    legalComments: 'none',
    metafile: true,
  })
  assertInputsWatched(avatars.metafile)
  checkBundledPackages(bundledPackages(result.metafile, avatars.metafile), args.updatePackages)
  // engine.wasm.js: the SDK's WASM (src/wasm-source.ts), gzip + base64 in one string literal, so it parses in one scan.
  const wasm = readFileSync(path.join(root, 'node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk_bg.wasm'))
  const wasmGzip = gzipSync(wasm, { level: 9 })
  writeFileSync(path.join(outdir, 'engine.wasm.js'), `window.__YAPPR_ENGINE_WASM__=${JSON.stringify(wasmGzip.toString('base64'))};\n`)

  // engine.js first, then the sidecars: every page runs them in this order (src/sidecar.ts). The avatar
  // styles go before the 11 MB WASM, so avatars drawn from the host's cached screens need not wait for it.
  const scripts = ['engine.js', 'engine.avatars.js', 'engine.wasm.js'].map(name => ({ name, source: readFileSync(path.join(outdir, name)) }))
  // engine.inline.html puts each script inside <script>: either sequence would end or corrupt it.
  for (const { name, source } of scripts) {
    for (const forbidden of [/<\/script/i, /<!--/]) {
      if (forbidden.test(source.toString('latin1'))) throw new Error(`${name} contains ${forbidden}; it cannot be inlined into engine.inline.html`)
    }
  }
  // One hash over all three: a new SDK or style set must never meet a cached page of the old one.
  const bundle = createHash('sha256')
  for (const { source } of scripts) bundle.update(source)
  const hash = bundle.digest('hex')
  const hashScript = `<script>globalThis.__YAPPR_ENGINE_BUNDLE_HASH__=${JSON.stringify(hash)}</script>`
  const head = `<!doctype html><html><head><meta charset="utf-8"><title>yappr engine</title>${hashScript}`
  const scriptTags = scripts.map(({ name }) => `<script src="${name}"></script>`).join('')
  writeFileSync(path.join(outdir, 'engine.html'), `${head}${scriptTags}</head><body></body></html>\n`)
  writeFileSync(path.join(outdir, 'engine.inline.html'), `${head}${scripts.map(({ source }) => `<script>${source}</script>`).join('')}</head><body></body></html>\n`)
  writeFileSync(path.join(outdir, 'meta.json'), JSON.stringify(result.metafile))

  // Diagnostics page: an in-page host for browsers nothing can drive (see src/selftest.ts).
  await build({ ...common, entryPoints: [path.join(here, 'src/selftest.ts')], outfile: path.join(outdir, 'selftest.js') })
  writeFileSync(path.join(outdir, 'selftest.html'), `${head}<meta name="viewport" content="width=device-width"></head><body><pre id="out" style="white-space:pre-wrap;font:14px monospace"></pre><script src="selftest.js"></script>${scriptTags}</body></html>\n`)

  const sourceOf = (name) => scripts.find(script => script.name === name).source
  const [js, wasmJs, avatarsJs] = ['engine.js', 'engine.wasm.js', 'engine.avatars.js'].map(sourceOf)
  const manifest = {
    ...engineBuild,
    ...config,
    sha256: hash,
    bytes: js.length,
    gzipBytes: gzipSync(js).length,
    wasm: { sha256: sha256(wasm), bytes: wasm.length, gzipBytes: wasmGzip.length, scriptBytes: wasmJs.length },
    avatars: { bytes: avatarsJs.length, gzipBytes: gzipSync(avatarsJs).length },
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
  console.log(`engine ${args.variant}: ${(js.length / 1e6).toFixed(2)} MB (${(manifest.gzipBytes / 1e6).toFixed(2)} MB gzip) + engine.wasm.js ${(wasmJs.length / 1e6).toFixed(2)} MB + engine.avatars.js ${(avatarsJs.length / 1e6).toFixed(2)} MB, sha256 ${hash.slice(0, 12)}, ${buildMs} ms → ${path.relative(process.cwd(), outdir)}`)
  for (const [file, bytes] of top) console.log(`  ${(bytes / 1e6).toFixed(2)} MB  ${file}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
