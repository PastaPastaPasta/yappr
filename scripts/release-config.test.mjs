import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import releaseConfig from './release-config.cjs'

const { assertReleaseConfig, storageScope } = releaseConfig
const template = parseEnv(readFileSync(new URL('../.env.testnet.template', import.meta.url), 'utf8'))

function completeEnv() {
  const env = { ...template, NEXT_PUBLIC_RELEASE: '1', STORAGE_EPOCH: 'testnet-release-1' }
  let index = 1
  const retired = new Set(['YAPPR_DM', 'KEY_EXCHANGE', 'YAPPR_VAULT', 'YAPPR_AUTH_VAULT', 'ENCRYPTED_KEY_BACKUP']
    .map(name => `NEXT_PUBLIC_${name}_CONTRACT_ID`))
  for (const key of Object.keys(env)) {
    const identifier = key.endsWith('_ID') || key === 'NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER'
    if (identifier && !retired.has(key) && env[key] === '') {
      env[key] = bs58.encode(new Uint8Array(32).fill(index++))
    }
  }
  env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS = [
    'APP_CONNECT_APP_ID', 'YAPPR_CONTRACT_ID', 'YAPPR_BLOCKS_CONTRACT_ID',
    'YAPPR_DM_V5_CONTRACT_ID', 'YAPPR_BLOG_CONTRACT_ID', 'POLLR_CONTRACT_ID',
    'YAPPR_STOREFRONT_CONTRACT_ID', 'YAPPR_PASSKEY_VAULT_CONTRACT_ID',
  ].map(name => `${env[`NEXT_PUBLIC_${name}`]}:1`).join(',')
  return env
}

describe('release build configuration', () => {
  it('ignores ambient release values and never lets release mode be disabled by the file', () => {
    const file = join(tmpdir(), `yappr-env-${process.pid}.env`)
    try {
      const configured = { ...completeEnv(), NEXT_PUBLIC_RELEASE: '0' }
      writeFileSync(file, Object.entries(configured).map(([key, value]) => `${key}=${value}`).join('\n'))
      const env = releaseConfig.loadReleaseEnv(file, { NEXT_PUBLIC_UNDECLARED: 'leaked', STORAGE_EPOCH: 'wrong', BASE_PATH: '/staging' })
      expect(env.NEXT_PUBLIC_UNDECLARED).toBeUndefined()
      expect(env.NEXT_PUBLIC_RELEASE).toBe('1')
      expect(env.STORAGE_EPOCH).toBe(configured.STORAGE_EPOCH)
      expect(env.BASE_PATH).toBe('/staging')
    } finally {
      rmSync(file, { force: true })
    }
  })

  it('documents every public application env reader except Next-generated metadata', () => {
    const generated = new Set(['BASE_PATH', 'GIT_BRANCH', 'GIT_COMMIT_DATE', 'GIT_COMMIT_HASH', 'STORAGE_SCOPE', 'SDK_WASM_URL']
      .map(name => `NEXT_PUBLIC_${name}`))
    for (const dir of ['app', 'components', 'contexts', 'hooks', 'lib', 'vendor/platform-auth/src']) {
      const root = new URL(`../${dir}/`, import.meta.url)
      for (const file of readdirSync(root, { recursive: true })) {
        if (!/\.(ts|tsx|mjs)$/.test(file) || /\.(test|spec)\./.test(file)) continue
        const source = readFileSync(new URL(file, root), 'utf8')
        for (const [key] of source.matchAll(/(?<=process\.env\.)NEXT_PUBLIC_[A-Z0-9_]+/g)) {
          if (!generated.has(key)) expect(template, `${file}: ${key}`).toHaveProperty(key)
        }
      }
    }
  })

  it('preserves non-release builds, including next dev/test fixtures', () => {
    expect(() => assertReleaseConfig({})).not.toThrow()
    expect(() => assertReleaseConfig(template)).not.toThrow()
  })

  it.each(['testnet', 'mainnet'])('accepts complete explicit %s release configuration', network => {
    expect(() => assertReleaseConfig({ ...completeEnv(), NEXT_PUBLIC_NETWORK: network })).not.toThrow()
  })

  it('reports all absent required keys together', () => {
    expect(() => assertReleaseConfig({ NEXT_PUBLIC_RELEASE: '1', NEXT_PUBLIC_NETWORK: 'testnet' }))
      .toThrow(/NEXT_PUBLIC_YAPPR_CONTRACT_ID[\s\S]*NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID[\s\S]*NEXT_PUBLIC_YAPP_TOKEN_ID[\s\S]*NEXT_PUBLIC_DM_TOPOLOGY[\s\S]*NEXT_PUBLIC_LOGIN_PROTOCOL/)
  })

  const base = completeEnv()
  it.each(Object.keys(base).filter(key =>
    (key.endsWith('_ID') && base[key] !== '') || key.endsWith('_TOPOLOGY') ||
    key === 'NEXT_PUBLIC_LOGIN_PROTOCOL' || key === 'NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER' ||
    key.startsWith('NEXT_PUBLIC_FEATURE_')))(
    'rejects missing or malformed %s', key => {
      for (const value of [undefined, '', 'placeholder', '  ', bs58.encode(new Uint8Array(31))]) {
        expect(() => assertReleaseConfig({ ...completeEnv(), [key]: value })).toThrow(key)
      }
    })

  it.each(['', 'devnet', 'typo'])('refuses an unset or unsupported release network (%s)', network => {
    expect(() => assertReleaseConfig({ ...completeEnv(), NEXT_PUBLIC_NETWORK: network })).toThrow('NEXT_PUBLIC_NETWORK')
  })

  it('rejects invalid release flag values', () => {
    expect(() => assertReleaseConfig({ NEXT_PUBLIC_RELEASE: 'true' })).toThrow('NEXT_PUBLIC_RELEASE')
  })

  it.each(['', ':0', ':01', ':-1', ':1.5', ':9007199254740992', ':1:2'])('requires explicit safe member versions (%s)', suffix => {
    const env = completeEnv()
    env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS = env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.replace(':1', suffix)
    expect(() => assertReleaseConfig(env)).toThrow('NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS')
  })

  it('rejects missing, duplicate and unexpected group members', () => {
    const env = completeEnv()
    const entries = env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.split(',')
    for (const members of [entries.slice(1).join(','), [...entries, entries[0]].join(','), `${entries.join(',')},${env.NEXT_PUBLIC_DPNS_CONTRACT_ID}:1`]) {
      expect(() => assertReleaseConfig({ ...env, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: members })).toThrow('NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS')
    }
  })

  it('requires retired ids to be explicitly blank', () => {
    const env = completeEnv()
    for (const value of [undefined, env.NEXT_PUBLIC_YAPPR_CONTRACT_ID]) {
      expect(() => assertReleaseConfig({ ...env, NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID: value })).toThrow('retired')
    }
  })

  it('requires separate contracts for separate roles', () => {
    const env = completeEnv()
    env.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID = env.NEXT_PUBLIC_YAPPR_CONTRACT_ID
    expect(() => assertReleaseConfig(env)).toThrow('distinct')
  })

  it('does not inherit an ambient epoch when the release file omits it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yappr-release-env-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      for (const file of ['build-release.mjs', 'release-config.cjs', 'write-static-404.mjs']) {
        copyFileSync(new URL(file, import.meta.url), join(dir, 'scripts', file))
      }
      symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir')
      const env = completeEnv()
      delete env.STORAGE_EPOCH
      writeFileSync(join(dir, '.env.testnet'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'))
      const result = spawnSync(process.execPath, [join(dir, 'scripts/build-release.mjs')], {
        cwd: dir,
        env: { ...process.env, STORAGE_EPOCH: 'testing' },
        encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('STORAGE_EPOCH must be a non-empty scope')
      expect(result.stdout).not.toContain('Creating an optimized production build')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { ambient: '', configured: undefined, expected: '', status: 0 },
    { ambient: '/yappr', configured: undefined, expected: '/yappr', status: 0 },
    { ambient: '/ambient', configured: '/release', expected: '/release', status: 0 },
    { ambient: '/yappr', configured: undefined, expected: '/yappr', status: 7 },
  ])('postprocesses successful release exports with the effective prefix: %j', ({ ambient, configured, expected, status }) => {
    const dir = mkdtempSync(join(tmpdir(), 'yappr-release-404-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      for (const file of ['build-release.mjs', 'release-config.cjs', 'write-static-404.mjs']) {
        copyFileSync(new URL(file, import.meta.url), join(dir, 'scripts', file))
      }
      mkdirSync(join(dir, 'node_modules/next/dist/bin'), { recursive: true })
      symlinkSync(fileURLToPath(new URL('../node_modules/bs58', import.meta.url)), join(dir, 'node_modules/bs58'), 'dir')
      // Exercise the owning release entry point; only Next's expensive export is substituted.
      writeFileSync(join(dir, 'node_modules/next/dist/bin/next'), `
        const fs = require('node:fs');
        fs.mkdirSync('out');
        fs.writeFileSync('out/404.html', '<script src="legacy-runtime.js"></script>');
        process.exit(${status});
      `)
      const env = completeEnv()
      if (configured !== undefined) env.BASE_PATH = configured
      writeFileSync(join(dir, '.env.testnet'), Object.entries(env).map(([key, value]) => key + '=' + value).join('\n'))
      const result = spawnSync(process.execPath, [join(dir, 'scripts/build-release.mjs')], {
        cwd: dir, env: { ...process.env, BASE_PATH: ambient }, encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(status)
      const html = readFileSync(join(dir, 'out/404.html'), 'utf8')
      if (status === 0) {
        expect(html).toContain(`href="${expected}/"`)
        expect(html).toContain(`href="${expected}/explore/"`)
        expect(html).toContain('location.replace')
        expect(html).not.toMatch(/_next|legacy-runtime|src=/)
      } else {
        expect(html).toContain('legacy-runtime')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['DEVNET_NAME', 'DAPI_ADDRESSES', 'QUORUM_URL', 'INSIGHT_API_URL'])(
    'requires NEXT_PUBLIC_%s to be explicitly blank in a release', name => {
      const key = `NEXT_PUBLIC_${name}`
      for (const value of [undefined, 'https://devnet.invalid']) {
        expect(() => assertReleaseConfig({ ...completeEnv(), [key]: value })).toThrow(key)
      }
    })

  describe('archival frontend flags (docs/ARCHIVE_FRONTEND.md)', () => {
    /** A scratch copy of the release entry point, with a stand-in `next` that records the env it was given. */
    function scratchRelease(file = '.env.testnet') {
      const dir = mkdtempSync(join(tmpdir(), 'yappr-release-archive-'))
      mkdirSync(join(dir, 'scripts'))
      for (const name of ['build-release.mjs', 'release-config.cjs', 'write-static-404.mjs']) {
        copyFileSync(new URL(name, import.meta.url), join(dir, 'scripts', name))
      }
      mkdirSync(join(dir, 'node_modules/next/dist/bin'), { recursive: true })
      symlinkSync(fileURLToPath(new URL('../node_modules/bs58', import.meta.url)), join(dir, 'node_modules/bs58'), 'dir')
      writeFileSync(join(dir, 'node_modules/next/dist/bin/next'), `
        const fs = require('node:fs');
        fs.mkdirSync('out');
        fs.writeFileSync('out/effective-env.json', JSON.stringify({
          view: process.env.NEXT_PUBLIC_MODERATION_VIEW ?? null,
          log: process.env.NEXT_PUBLIC_MODERATION_LOG ?? null,
        }));
      `)
      const run = (fileEnv, ambient) => {
        writeFileSync(join(dir, file), Object.entries({ ...completeEnv(), ...fileEnv }).map(([key, value]) => `${key}=${value}`).join('\n'))
        return spawnSync(process.execPath, [join(dir, 'scripts/build-release.mjs'), ...(file === '.env.testnet' ? [] : [file])], {
          cwd: dir, encoding: 'utf8', env: { ...process.env, ...ambient, ...(file === '.env.staging-old' ? { BASE_PATH: '/staging-old' } : {}) },
        })
      }
      return { dir, run }
    }
    const effective = dir => JSON.parse(readFileSync(join(dir, 'out/effective-env.json'), 'utf8'))

    it.each([
      ['NEXT_PUBLIC_MODERATION_VIEW', ['all', 'default', '0', '1', 'true', ' ']],
      ['NEXT_PUBLIC_MODERATION_LOG', ['1', 'true', 'all', ' ']],
    ])('a release refuses %s set to anything but off', (key, values) => {
      for (const value of values) {
        expect(() => assertReleaseConfig({ ...completeEnv(), [key]: value }), `${key}=${JSON.stringify(value)}`).toThrow(key)
      }
    })

    it.each([
      ['NEXT_PUBLIC_MODERATION_VIEW', [undefined, '']],
      ['NEXT_PUBLIC_MODERATION_LOG', [undefined, '', '0']],
    ])('a release accepts %s unset or off', (key, values) => {
      for (const value of values) expect(() => assertReleaseConfig({ ...completeEnv(), [key]: value })).not.toThrow()
    })

    it('names every flag that is on, and leaves non-release builds alone', () => {
      const flags = { NEXT_PUBLIC_MODERATION_VIEW: 'all', NEXT_PUBLIC_MODERATION_LOG: '1' }
      expect(() => assertReleaseConfig({ ...completeEnv(), ...flags })).toThrow(/NEXT_PUBLIC_MODERATION_VIEW[\s\S]*NEXT_PUBLIC_MODERATION_LOG/)
      // An archival build is exactly what a non-release build (devnet, /testing, mobile non-release variants) may be.
      expect(() => assertReleaseConfig(flags)).not.toThrow()
      expect(() => assertReleaseConfig({ ...flags, NEXT_PUBLIC_RELEASE: '0' })).not.toThrow()
    })

    it.each(['.env.testnet', '.env.staging-old'])('%s: a flag in the env file fails the build before next runs', file => {
      const { dir, run } = scratchRelease(file)
      try {
        for (const fileEnv of [{ NEXT_PUBLIC_MODERATION_VIEW: 'all' }, { NEXT_PUBLIC_MODERATION_LOG: '1' }]) {
          const result = run(fileEnv, {})
          expect(result.status).toBe(1)
          expect(result.stderr).toContain(Object.keys(fileEnv)[0])
          expect(result.stdout).not.toContain('Creating an optimized production build')
          expect(() => readFileSync(join(dir, 'out/effective-env.json'))).toThrow()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('an ambient flag fails the build too, instead of being dropped silently', () => {
      const { dir, run } = scratchRelease()
      try {
        for (const ambient of [{ NEXT_PUBLIC_MODERATION_VIEW: 'all' }, { NEXT_PUBLIC_MODERATION_LOG: '1' }]) {
          const result = run({}, ambient)
          expect(result.status).toBe(1)
          expect(result.stderr).toContain(Object.keys(ambient)[0])
          expect(result.stderr).toContain('ambient')
          expect(() => readFileSync(join(dir, 'out/effective-env.json'))).toThrow()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('hands next an explicit off value, so a stray .env.local cannot supply a flag', () => {
      const { dir, run } = scratchRelease()
      try {
        const result = run({}, { NEXT_PUBLIC_MODERATION_LOG: '0', NEXT_PUBLIC_MODERATION_VIEW: '' })
        expect(result.status, result.stderr).toBe(0)
        expect(effective(dir)).toEqual({ view: '', log: '' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('keeps an explicit 0 from the env file', () => {
      const { dir, run } = scratchRelease()
      try {
        const result = run({ NEXT_PUBLIC_MODERATION_LOG: '0' }, {})
        expect(result.status, result.stderr).toBe(0)
        expect(effective(dir)).toEqual({ view: '', log: '0' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('next.config.js re-checks the environment after Next has loaded its env files', () => {
      const root = fileURLToPath(new URL('../', import.meta.url))
      const check = flags => spawnSync(process.execPath, ['-e', "require('./next.config.js')('phase-production-build')"], {
        cwd: root, encoding: 'utf8', env: { ...process.env, ...completeEnv(), ...flags },
      })
      // Control: the same environment without a flag builds its config.
      const clean = check({ NEXT_PUBLIC_MODERATION_VIEW: '', NEXT_PUBLIC_MODERATION_LOG: '' })
      expect(clean.status, clean.stderr).toBe(0)
      for (const flags of [{ NEXT_PUBLIC_MODERATION_VIEW: 'all' }, { NEXT_PUBLIC_MODERATION_LOG: '1' }]) {
        const result = check(flags)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(Object.keys(flags)[0])
      }
    })
  })

  it.each(['', '/staging'])('builds root and /staging (base %j) from .env.testnet, never ambient pins', basePath => {
    const dir = mkdtempSync(join(tmpdir(), 'yappr-release-entry-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      for (const name of ['build-release.mjs', 'release-config.cjs', 'write-static-404.mjs']) {
        copyFileSync(new URL(name, import.meta.url), join(dir, 'scripts', name))
      }
      mkdirSync(join(dir, 'node_modules/next/dist/bin'), { recursive: true })
      symlinkSync(fileURLToPath(new URL('../node_modules/bs58', import.meta.url)), join(dir, 'node_modules/bs58'), 'dir')
      writeFileSync(join(dir, 'node_modules/next/dist/bin/next'), `
        const fs = require('node:fs');
        fs.mkdirSync('out');
        fs.writeFileSync('out/effective-env.json', JSON.stringify({
          BASE_PATH: process.env.BASE_PATH,
          NEXT_PUBLIC_YAPPR_CONTRACT_ID: process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID,
        }));
      `)
      const configured = completeEnv()
      writeFileSync(join(dir, '.env.testnet'), Object.entries(configured).map(([key, value]) => `${key}=${value}`).join('\n'))
      const result = spawnSync(process.execPath, [join(dir, 'scripts/build-release.mjs')], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_PATH: basePath, NEXT_PUBLIC_YAPPR_CONTRACT_ID: 'ambient-wrong-id' },
      })
      expect(result.status, result.stderr).toBe(0)
      const effective = JSON.parse(readFileSync(join(dir, 'out/effective-env.json'), 'utf8'))
      expect(effective).toEqual({ BASE_PATH: basePath, NEXT_PUBLIC_YAPPR_CONTRACT_ID: configured.NEXT_PUBLIC_YAPPR_CONTRACT_ID })
      const refused = spawnSync(process.execPath, [join(dir, 'scripts/build-release.mjs'), '.env.staging'], { cwd: dir, encoding: 'utf8' })
      expect(refused.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    { file: '.env.testnet', basePath: '', ambient: '1', flag: undefined },
    { file: '.env.staging-old', basePath: '/staging-old', ambient: undefined, flag: '1' },
    { file: '.env.staging-old', basePath: '/staging', ambient: undefined, flag: null },
    { file: '.env.staging-old', basePath: '', ambient: undefined, flag: null },
  ])('only build:staging-old turns on its snapshot: %j', ({ file, basePath, ambient, flag }) => {
    const dir = mkdtempSync(join(tmpdir(), 'yappr-staging-old-entry-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      for (const name of ['build-release.mjs', 'release-config.cjs', 'write-static-404.mjs']) {
        copyFileSync(new URL(name, import.meta.url), join(dir, 'scripts', name))
      }
      mkdirSync(join(dir, 'node_modules/next/dist/bin'), { recursive: true })
      symlinkSync(fileURLToPath(new URL('../node_modules/bs58', import.meta.url)), join(dir, 'node_modules/bs58'), 'dir')
      writeFileSync(join(dir, 'node_modules/next/dist/bin/next'), `
        const fs = require('node:fs');
        fs.mkdirSync('out');
        fs.writeFileSync('out/effective-env.json', JSON.stringify({ YAPPR_STAGING_OLD: process.env.YAPPR_STAGING_OLD }));
      `)
      writeFileSync(join(dir, file), Object.entries(completeEnv()).map(([key, value]) => `${key}=${value}`).join('\n'))
      const result = spawnSync(process.execPath, [join(dir, 'scripts/build-release.mjs'), ...(file === '.env.testnet' ? [] : [file])], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_PATH: basePath, ...(ambient ? { YAPPR_STAGING_OLD: ambient } : {}) },
      })
      if (flag === null) {
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('BASE_PATH=/staging-old')
      } else {
        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(join(dir, 'out/effective-env.json'), 'utf8')).YAPPR_STAGING_OLD).toBe(flag)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the checked-in .env.staging-old pins the D36 rehearsal set, scoped apart, and matches its snapshot', () => {
    const rehearsal = parseEnv(readFileSync(new URL('../.env.staging-old', import.meta.url), 'utf8'))
    expect(Object.keys(rehearsal).sort()).toEqual(Object.keys(template).sort())
    expect(() => assertReleaseConfig(rehearsal)).not.toThrow()
    expect(rehearsal.NEXT_PUBLIC_YAPPR_CONTRACT_ID).toBe('AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9')
    expect(rehearsal.NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER).toBe('At8Xd9BpbVbzxvrna2smE3GbACeTaxf7YGUEwn7FHUZF')
    const release = parseEnv(readFileSync(new URL('../.env.testnet', import.meta.url), 'utf8'))
    expect(rehearsal.STORAGE_EPOCH).not.toBe(release.STORAGE_EPOCH)
    expect(storageScope('/staging-old', rehearsal.STORAGE_EPOCH)).toBe('testnet-staging-old-1:staging-old')
    const snapshot = JSON.parse(readFileSync(new URL('../lib/contracts/snapshots/testnet-staging-old.json', import.meta.url), 'utf8'))
    expect(() => releaseConfig.assertSnapshotPins(snapshot, rehearsal)).not.toThrow()
    expect(() => releaseConfig.assertSnapshotPins(snapshot, release)).toThrow('exact contract pins')
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(scripts['build:staging-old']).toBe('BASE_PATH=/staging-old node scripts/build-release.mjs .env.staging-old')
  })

  it('the checked-in .env.testnet is the complete registered release, and `build` uses it', () => {
    const release = parseEnv(readFileSync(new URL('../.env.testnet', import.meta.url), 'utf8'))
    expect(Object.keys(release).sort()).toEqual(Object.keys(template).sort())
    expect(() => assertReleaseConfig(release)).not.toThrow()
    expect(release.NEXT_PUBLIC_RELEASE).toBe('1')
    expect(storageScope('/staging', release.STORAGE_EPOCH)).toBe('testnet-release-1:staging')
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(scripts.build).toBe('npm run build:release')
    expect(scripts['build:staging']).toBe('BASE_PATH=/staging npm run build')
  })

  it('bundles every pinned release contract at its pinned version, plus the profile and system contracts', () => {
    const release = parseEnv(readFileSync(new URL('../.env.testnet', import.meta.url), 'utf8'))
    const { network, contracts } = JSON.parse(readFileSync(new URL('../lib/contracts/bundled/testnet.json', import.meta.url), 'utf8'))
    expect(network).toBe('testnet')
    for (const [id, version] of release.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.split(',').map(pin => pin.split(':'))) {
      expect(contracts[id]?.version, id).toBe(Number(version))
    }
    for (const key of ['NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID', 'NEXT_PUBLIC_DPNS_CONTRACT_ID', 'NEXT_PUBLIC_TOKEN_HISTORY_CONTRACT_ID']) {
      expect(contracts, key).toHaveProperty(release[key])
    }
  })

  it.each([undefined, '', 'bad:scope'])('requires a clean-start storage epoch (%s)', epoch => {
    expect(() => assertReleaseConfig({ ...completeEnv(), STORAGE_EPOCH: epoch })).toThrow('STORAGE_EPOCH')
  })
})

describe('storage epoch', () => {
  it('preserves existing scopes until opt-in and isolates release subpaths', () => {
    expect(storageScope('')).toBe('')
    expect(storageScope('/staging')).toBe('staging')
    expect(storageScope('', 'testnet-release-1')).toBe('testnet-release-1')
    expect(storageScope('/staging', 'testnet-release-1')).toBe('testnet-release-1:staging')
    expect(() => storageScope('', 'bad:scope')).toThrow('STORAGE_EPOCH')
  })
})
