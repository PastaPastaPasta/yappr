const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { gzipSync } = require('node:zlib')
const { join } = require('node:path')

// A gzip file, rather than base64 inside JS: works on static hosts even when
// they don't compress application/wasm. Raw rc.4 exceeds Pages' 25 MiB limit.
function sdkWasmAsset(root) {
  const raw = readFileSync(join(root, 'node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk_bg.wasm'))
  const hash = createHash('sha256').update(raw).digest('hex')
  let compressed
  return { name: `static/wasm/sdk-${hash}.wasm.gz`, get bytes() { return compressed ??= gzipSync(raw, { level: 9 }) } }
}

module.exports = { sdkWasmAsset }
