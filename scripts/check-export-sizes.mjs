/**
 * Fails when any file in the static export is larger than Cloudflare Pages
 * accepts (25 MiB per file). Pages preview deploys reject the whole upload
 * otherwise, and until this ran in CI that only showed up on Cloudflare's
 * check, long after `next build` passed.
 *
 *   npm run build && node scripts/check-export-sizes.mjs [--dir out] [--limit-bytes 26214400]
 *
 * Public routes also enforce an 8 MiB raw eager-JavaScript budget
 * (override with --max-eager-bytes) to catch SDK/editor hydration regressions.
 * Data entry routes must retain their parser-time WASM download in the head,
 * even when a client rendering gate suppresses the route body during SSR.
 * Always prints the largest files so a creeping chunk is visible before it
 * crosses the limit. Exit code 1 when any file is over, 2 when the export
 * directory is missing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const PAGES_FILE_LIMIT_BYTES = 25 * 1024 * 1024
const SHOW_LARGEST = 8

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dir = argValue('--dir', 'out')
const limit = Number(argValue('--limit-bytes', PAGES_FILE_LIMIT_BYTES))
const eagerLimit = Number(argValue('--max-eager-bytes', 8 * 1024 * 1024))
if (!Number.isFinite(eagerLimit) || eagerLimit <= 0) {
  console.error('--max-eager-bytes must be a positive number')
  process.exit(2)
}
if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`--limit-bytes must be a positive number, got "${argValue('--limit-bytes')}"`)
  process.exit(2)
}

function* walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

let files
try {
  files = [...walk(dir)].map(file => ({ file, size: statSync(file).size }))
} catch (err) {
  console.error(`Cannot read export directory "${dir}": ${err.message}. Run \`npm run build\` first.`)
  process.exit(2)
}

files.sort((a, b) => b.size - a.size)

console.log(`Largest files in ${dir}/ (limit ${limit} B = ${formatMiB(limit)}):`)
for (const { file, size } of files.slice(0, SHOW_LARGEST)) {
  console.log(`  ${String(size).padStart(10)} B  ${formatMiB(size).padStart(10)}  ${file}`)
}

const tooLarge = files.filter(f => f.size > limit)
if (tooLarge.length > 0) {
  for (const { file, size } of tooLarge) {
    console.error(`::error file=${file}::${file} is ${size} B (${formatMiB(size)}), over the ${formatMiB(limit)} Cloudflare Pages per-file limit`)
  }
  console.error(`${tooLarge.length} file(s) over the limit; Cloudflare Pages would reject this export.`)
  process.exit(1)
}
console.log(`OK: ${files.length} files, none over the limit.`)

// Measure scripts required to hydrate each public route, excluding later dynamic imports.
// Strip the deployment base path: exports always store assets under out/_next.
for (const route of ['/', '/feed', '/post', '/user', '/terms', '/blog/compose']) {
  const htmlFile = path.join(dir, route, 'index.html')
  let html
  try { html = readFileSync(htmlFile, 'utf8') } catch { continue }
  if (['/feed', '/post', '/user'].includes(route)) {
    const head = html.slice(0, html.indexOf('</head>'))
    const bootstrap = [...head.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map(match => match[1]).find(script => script.includes('window.__yapprSdkWasm'))
    const asset = bootstrap?.match(/\/_next\/static\/wasm\/sdk-[a-f0-9]{64}\.wasm\.gz/)?.[0]
    if (!bootstrap || !asset || !files.some(({ file }) => file === path.join(dir, asset.slice(1)))) {
      console.error(`::error file=${htmlFile}::${route} is missing its head bootstrap or matching WASM asset.`)
      process.exitCode = 1
    } else {
      // Also catch broken serialized function syntax before shipping the export.
      try { new Function(bootstrap) } catch (error) {
        console.error(`::error file=${htmlFile}::Invalid WASM bootstrap: ${error.message}`)
        process.exitCode = 1
      }
    }
  }
  const scripts = new Set([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g)].map(match => match[1]))
  let raw = 0
  let gzip = 0
  for (const src of scripts) {
    const local = src.slice(src.indexOf('/_next/') + 1)
    const bytes = readFileSync(path.join(dir, local))
    raw += bytes.length
    gzip += gzipSync(bytes).length
  }
  console.log(`Route ${route}: ${scripts.size} eager scripts, ${raw} B raw, ${gzip} B gzip`)
  if (raw > eagerLimit) {
    console.error(`::error file=${htmlFile}::${route} eagerly loads ${raw} B of JavaScript (limit ${eagerLimit} B). Check for SDK or editor imports in shared components.`)
    process.exitCode = 1
  }
}
