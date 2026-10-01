/**
 * Bundles src/main.ts (and the vendor/platform-auth protocol module it reuses)
 * into dist/test-wallet-responder.mjs. npm packages stay external: Node
 * resolves them from the repo root's node_modules, so the responder shares the
 * root's @dashevo/evo-sdk with scripts/sdk-env.mjs.
 */
import { build as esbuild } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUTFILE = join(here, 'dist', 'test-wallet-responder.mjs')

export async function build() {
  await esbuild({
    entryPoints: [join(here, 'src', 'main.ts')],
    outfile: OUTFILE,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  })
  return OUTFILE
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await build())
}
