/**
 * Fails when any file in the static export is larger than Cloudflare Pages
 * accepts (25 MiB per file). Pages preview deploys reject the whole upload
 * otherwise, and until this ran in CI that only showed up on Cloudflare's
 * check, long after `next build` passed.
 *
 *   npm run build && node scripts/check-export-sizes.mjs [--dir out] [--limit-bytes 26214400]
 *
 * Always prints the largest files so a creeping chunk is visible before it
 * crosses the limit. Exit code 1 when any file is over, 2 when the export
 * directory is missing.
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const PAGES_FILE_LIMIT_BYTES = 25 * 1024 * 1024
const SHOW_LARGEST = 8

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dir = argValue('--dir', 'out')
const limit = Number(argValue('--limit-bytes', PAGES_FILE_LIMIT_BYTES))
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
