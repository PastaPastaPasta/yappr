const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { brotliCompressSync, brotliDecompressSync, constants, gzipSync } = require('node:zlib')
const { join } = require('node:path')

// Compressed files, rather than base64 inside JS: they work on static hosts
// even when those don't compress application/wasm, and raw rc.4 exceeds
// Pages' 25 MiB limit. The gzip file is the one every browser can decode;
// the brotli file (about a third smaller) is for browsers whose
// DecompressionStream reads brotli (lib/web-wasm-preload.ts picks).
function sdkWasmAsset(root) {
  const raw = readFileSync(join(root, 'node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk_bg.wasm'))
  const hash = sha256(raw)
  const name = `static/wasm/sdk-${hash}.wasm.gz`
  let gzip
  let brotli
  return {
    name,
    brotliName: name.replace(/\.gz$/, '.br'),
    get bytes() { return gzip ??= gzipSync(raw, { level: 9 }) },
    // Quality 11 takes about 45 s, so it is kept across builds per WASM hash.
    get brotliBytes() { return brotli ??= cachedBrotli(root, hash, raw) },
  }
}

const BROTLI_PARAMS = { quality: 11, lgwin: 24 }

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The brotli file, reused from an earlier build only if it decodes to this exact WASM. */
function cachedBrotli(root, hash, raw) {
  const dir = join(root, 'node_modules/.cache/yappr-sdk-wasm')
  const file = join(dir, `sdk-${hash}.q${BROTLI_PARAMS.quality}w${BROTLI_PARAMS.lgwin}.wasm.br`)
  try {
    const cached = readFileSync(file)
    if (sha256(brotliDecompressSync(cached)) === hash) return cached
  } catch { /* Missing or damaged: compress again below. */ }
  const bytes = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_PARAMS.quality,
      [constants.BROTLI_PARAM_LGWIN]: BROTLI_PARAMS.lgwin,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  })
  try {
    // Written aside and renamed, so a killed or parallel build never leaves a partial file.
    mkdirSync(dir, { recursive: true })
    const partial = `${file}.${process.pid}.tmp`
    writeFileSync(partial, bytes)
    renameSync(partial, file)
  } catch { /* The cache is an optimization; the build still has the bytes. */ }
  return bytes
}

module.exports = { sdkWasmAsset }
