import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { parseEnv } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const envs = {
  'staging-old': parseEnv(readFileSync(join(root, '.env.staging-old'), 'utf8')),
  beta: parseEnv(readFileSync(join(root, '.env.beta'), 'utf8')),
}
afterEach(() => {
  vi.unstubAllEnvs()
  delete require.cache[require.resolve('../next.config.js')]
})

function webpackFor(overrides, name = 'staging-old') {
  for (const [key, value] of Object.entries({ ...envs[name], BASE_PATH: `/${name}`, YAPPR_QA_BUILD: name, ...overrides })) vi.stubEnv(key, value)
  const config = require('../next.config.js')('phase-production-build')
  let replace
  const webpack = { NormalModuleReplacementPlugin: class {
    constructor(_pattern, callback) { replace = callback }
    apply() {}
  } }
  const run = () => config.webpack({ plugins: [], resolve: {} }, { isServer: false, webpack })
  return { run, replace: resource => replace(resource) }
}

it.each(['staging-old', 'beta'])('%s substitutes its own snapshot and rejects a client compilation that never did', name => {
  const { run, replace } = webpackFor({}, name)
  const built = run()
  let afterCompile
  const compiler = { hooks: {
    thisCompilation: { tap() {} },
    afterCompile: { tap(_name, callback) { afterCompile = callback } },
  } }
  for (const plugin of built.plugins) plugin.apply(compiler)
  const missing = { errors: [] }
  afterCompile(missing)
  expect(missing.errors[0].message).toContain('snapshot was not bundled')
  // Webpack filters by the file-name pattern; the callback leaves a testnet.json elsewhere alone.
  const elsewhere = { context: join(root, 'lib/other'), request: './testnet.json' }
  replace(elsewhere)
  expect(elsewhere.request).toBe('./testnet.json')
  const stillMissing = { errors: [] }
  afterCompile(stillMissing)
  expect(stillMissing.errors).toHaveLength(1)
  const resource = { context: join(root, 'lib/contracts/bundled'), request: './testnet.json' }
  replace(resource)
  expect(resource.request).toBe(join(root, `lib/contracts/snapshots/testnet-${name}.json`))
  const included = { errors: [] }
  afterCompile(included)
  expect(included.errors).toEqual([])
})

it.each([{ BASE_PATH: '/staging' }, { BASE_PATH: '' }, { BASE_PATH: '/beta' }, { NEXT_PUBLIC_NETWORK: 'mainnet' }, { NEXT_PUBLIC_RELEASE: '0' }])(
  'refuses the /staging-old build anywhere but testnet /staging-old: %j', overrides => {
    expect(() => webpackFor(overrides).run()).toThrow(/served only at BASE_PATH=\/staging-old|testnet only|restricted to the testnet \/staging-old release build/)
  })

it.each([{ BASE_PATH: '/staging-old' }, { BASE_PATH: '' }, { NEXT_PUBLIC_NETWORK: 'mainnet' }])(
  'refuses the /beta build anywhere but testnet /beta: %j', overrides => {
    expect(() => webpackFor(overrides, 'beta').run()).toThrow(/served only at BASE_PATH=\/beta|testnet only/)
  })
