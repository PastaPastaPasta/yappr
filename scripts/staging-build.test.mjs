import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { parseEnv } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
afterEach(() => {
  vi.unstubAllEnvs()
  delete require.cache[require.resolve('../next.config.js')]
})

it('rejects a client compilation when the staging snapshot was never substituted', () => {
  const env = parseEnv(readFileSync(join(root, '.env.staging'), 'utf8'))
  for (const [key, value] of Object.entries({ ...env, BASE_PATH: '/staging', YAPPR_STAGING_REHEARSAL: '1' })) vi.stubEnv(key, value)
  const config = require('../next.config.js')('phase-production-build')
  let replace
  const webpack = { NormalModuleReplacementPlugin: class {
    constructor(_pattern, callback) { replace = callback }
    apply() {}
  } }
  const built = config.webpack({ plugins: [], resolve: {} }, { isServer: false, webpack })
  let afterCompile
  const compiler = { hooks: {
    thisCompilation: { tap() {} },
    afterCompile: { tap(_name, callback) { afterCompile = callback } },
  } }
  for (const plugin of built.plugins) plugin.apply(compiler)
  const missing = { errors: [] }
  afterCompile(missing)
  expect(missing.errors[0].message).toContain('snapshot was not bundled')
  const resource = { context: join(root, 'lib/contracts/bundled'), request: './testnet.json' }
  replace(resource)
  expect(resource.request).toBe(join(root, 'lib/contracts/snapshots/testnet-staging.json'))
  const included = { errors: [] }
  afterCompile(included)
  expect(included.errors).toEqual([])
})
