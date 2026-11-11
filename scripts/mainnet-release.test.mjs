import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import releaseConfig from './release-config.cjs'
import { snapshotContractIds, snapshotEnvFiles } from './snapshot-contract-config.mjs'
import { APP_CONNECT_ENTRIES, appConnectEnvLines, planAppConnectSet } from './app-connect-set.mjs'

const read = file => parseEnv(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
const template = read('.env.mainnet.template')
const otherFiles = ['.env.testnet', '.env.beta', '.env.staging-old', '.env.testing', '.env.devnet']
const systemKeys = ['NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID', 'NEXT_PUBLIC_DPNS_CONTRACT_ID', 'NEXT_PUBLIC_TOKEN_HISTORY_CONTRACT_ID']
const memberKeys = APP_CONNECT_ENTRIES.map(entry => entry.envKey)
const idKeys = [...memberKeys, ...['APP_CONNECT_GROUP_ID', 'APP_CONNECT_GROUP_OWNER', 'YAPP_TOKEN_ID', 'YAPP_TOKEN_AUTHORITY_ID']
  .map(name => `NEXT_PUBLIC_${name}`)]
const plan = planAppConnectSet({
  makerId: bs58.encode(new Uint8Array(32).fill(100)), startNonce: 1n,
  generateId: (_owner, nonce) => bs58.encode(new Uint8Array(32).fill(100 + Number(nonce))),
})
const plannedEnv = parseEnv(appConnectEnvLines(plan).join('\n'))

function completeMainnet() {
  const env = { ...template, ...plannedEnv, NEXT_PUBLIC_MASTERNODE_VOTE_URL: 'https://vote.example.org/#/m/{contract}',
    NEXT_PUBLIC_YAPP_TOKEN_AUTHORITY_ID: plan.groupOwner,
    NEXT_PUBLIC_YAPP_TOKEN_ID: bs58.encode(new Uint8Array(32).fill(120)) }
  env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS = plannedEnv.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.split(',').map(id => `${id}:1`).join(',')
  return env
}

function writeEnv(file, env) {
  writeFileSync(file, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'))
}

describe('mainnet release', () => {
  it('accepts the registrar mainnet release plan with explicit versions, refusing v18, missing or reordered members', () => {
    const env = completeMainnet()
    expect(env.NEXT_PUBLIC_NETWORK).toBe('mainnet')
    expect(() => releaseConfig.assertReleaseConfig(env)).not.toThrow()
    // Registrar output needs the explicit versions read back after registration.
    expect(() => releaseConfig.assertReleaseConfig({ ...env,
      NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: plannedEnv.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS })).toThrow('id:version pins')
    const members = env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.split(',')
    expect(members.map(pin => pin.split(':')[0])).toEqual(plan.contracts.map(contract => contract.id))
    const v18 = read('.env.beta').NEXT_PUBLIC_YAPPR_CONTRACT_ID
    expect(() => releaseConfig.assertReleaseConfig({ ...env,
      NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: [...members, `${v18}:1`].join(',') })).toThrow(`unexpected member ${v18}`)
    for (const [index, key] of memberKeys.entries()) {
      expect(() => releaseConfig.assertReleaseConfig({ ...env,
        NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: members.filter((_, i) => i !== index).join(',') })).toThrow(`must pin ${key}`)
    }
    expect(() => releaseConfig.assertReleaseConfig({ ...env,
      NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: members.toReversed().join(',') })).toThrow('registrar release order')
  })

  it('keeps every application id blank in the template and pins only verified system ids', () => {
    expect(Object.keys(template).sort()).toEqual(Object.keys(read('.env.testnet.template')).sort())
    for (const key of idKeys) expect(template[key], key).toBe('')
    expect(template.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS).toBe('')
    expect(template.NEXT_PUBLIC_MASTERNODE_VOTE_URL).toBe('')
    for (const key of systemKeys) expect(template[key]).toBe(read('.env.testnet')[key])
    expect(() => releaseConfig.assertReleaseConfig(template)).toThrow('incomplete')
    expect(() => releaseConfig.assertReleaseConfig(completeMainnet())).not.toThrow()
  })

  it.each([...idKeys, ...systemKeys])('refuses missing or malformed %s', key => {
    for (const value of [undefined, '', 'placeholder', bs58.encode(new Uint8Array(31))]) {
      expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), [key]: value })).toThrow(key)
    }
  })

  it.each(otherFiles)('rejects every non-system id from %s in every mainnet registration slot', file => {
    const ids = Object.values(read(file)).flatMap(value => value.split(',').map(part => part.split(':')[0]))
      .filter(value => { try { return bs58.decode(value).length === 32 } catch { return false } })
    expect(ids.length).toBeGreaterThan(0)
    for (const id of new Set(ids)) {
      for (const key of idKeys) {
        expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), [key]: id })).toThrow(key)
      }
    }
  })

  it('rejects legacy testnet ids still used as runtime defaults', () => {
    const source = readFileSync(new URL('../lib/constants.ts', import.meta.url), 'utf8')
    for (const [, id] of source.matchAll(/['"]([1-9A-HJ-NP-Za-km-z]{32,44})['"]/g)) {
      expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), NEXT_PUBLIC_YAPPR_CONTRACT_ID: id })).toThrow('NEXT_PUBLIC_YAPPR_CONTRACT_ID')
    }
  })

  it.each(['/staging', '/testing', '/devnet'])('refuses the existing deployment path %s', path => {
    expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), BASE_PATH: path })).toThrow('BASE_PATH')
  })

  it('allows shared system ids only in their verified roles', () => {
    for (const key of systemKeys) {
      expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), [key]: completeMainnet().NEXT_PUBLIC_YAPPR_CONTRACT_ID })).toThrow('verified mainnet system id')
      expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER: template[key] })).toThrow('system id')
    }
  })

  it.each(['testnet', 'devnet', ''])('requires the mainnet target to load NETWORK=mainnet, rejecting %s', network => {
    const dir = mkdtempSync(join(tmpdir(), 'yappr-mainnet-network-'))
    try {
      const file = join(dir, 'pins.env')
      writeEnv(file, { ...completeMainnet(), NEXT_PUBLIC_NETWORK: network })
      expect(() => releaseConfig.loadReleaseEnv(file, {}, null, 'mainnet')).toThrow('NEXT_PUBLIC_NETWORK=mainnet')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'NEXT_PUBLIC_BLOG_TOPOLOGY', 'NEXT_PUBLIC_STOREFRONT_TOPOLOGY',
    'NEXT_PUBLIC_POLLR_TOPOLOGY', 'NEXT_PUBLIC_DM_TOPOLOGY', 'NEXT_PUBLIC_PROFILE_TOPOLOGY',
    'NEXT_PUBLIC_LOGIN_PROTOCOL', 'NEXT_PUBLIC_FEATURE_STORE', 'NEXT_PUBLIC_FEATURE_BLOG', 'NEXT_PUBLIC_FEATURE_CREDIT_TIPS',
    'NEXT_PUBLIC_APP_CONNECT_CARRIER', 'STORAGE_EPOCH'])(
    'requires the release policy for %s', key => {
      expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), [key]: 'wrong' })).toThrow(key)
    })

  it('pins exactly the eight release members with explicit versions', () => {
    const env = completeMainnet()
    const entries = env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.split(',')
    for (const pins of ['', entries.slice(1).join(','), [...entries, entries[0]].join(','),
      [...entries, `${env.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID}:1`].join(','),
      env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.replace(':1', ':0')]) {
      expect(() => releaseConfig.assertReleaseConfig({ ...env, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: pins })).toThrow('GROUP_MEMBERS')
    }
    env[memberKeys[1]] = env[memberKeys[0]]
    expect(() => releaseConfig.assertReleaseConfig(env)).toThrow('distinct')
  })

  it.each(['', undefined, 'http://vote.example.org', 'https://example.org/evovote-testnet/#/m/{contract}',
    'https://example.org/evovote-%74estnet/', 'https://devnet.example.org/', 'https://user:pass@example.org/', 'not a URL'])(
    'refuses an absent, unsafe or non-mainnet vote URL (%s)', url => {
      expect(() => releaseConfig.assertReleaseConfig({ ...completeMainnet(), NEXT_PUBLIC_MASTERNODE_VOTE_URL: url })).toThrow('NEXT_PUBLIC_MASTERNODE_VOTE_URL')
    })

  it('snapshots mainnet from its own pins and checks the exact network, membership and versions', () => {
    const env = completeMainnet()
    expect(snapshotEnvFiles('mainnet')).toEqual(['.env.mainnet'])
    const ids = snapshotContractIds([{ ...env, NEXT_PUBLIC_SOCIAL_V18_CONTRACT_ID: read('.env.beta').NEXT_PUBLIC_YAPPR_CONTRACT_ID }],
      '', env.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID, ['v17'])
    expect(ids).toEqual([...plan.contracts.map(contract => contract.id), ...systemKeys.map(key => template[key])].sort())
    const snapshot = { network: 'mainnet', contracts: Object.fromEntries(ids.map(id => [id, { version: 1, bytes: 'fixture' }])) }
    expect(() => releaseConfig.assertSnapshotPins(snapshot, env)).not.toThrow()
    expect(() => releaseConfig.assertSnapshotPins({ ...snapshot, network: 'testnet' }, env)).toThrow('exact contract pins')
    const social = env.NEXT_PUBLIC_YAPPR_CONTRACT_ID
    snapshot.contracts[social].version = 2
    expect(() => releaseConfig.assertSnapshotPins(snapshot, env)).toThrow('exact contract pins')
    delete snapshot.contracts[social]
    expect(() => releaseConfig.assertSnapshotPins(snapshot, env)).toThrow('exact contract pins')
  })

  it('builds from an explicit mainnet env path, ignores ambient pins, and refuses bad input before Next', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yappr-mainnet-cli-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      for (const file of ['build-release.mjs', 'release-config.cjs', 'app-connect-entries.cjs', 'write-static-404.mjs']) {
        copyFileSync(new URL(file, import.meta.url), join(dir, 'scripts', file))
      }
      mkdirSync(join(dir, 'lib'))
      copyFileSync(new URL('../lib/constants.ts', import.meta.url), join(dir, 'lib/constants.ts'))
      for (const file of otherFiles) copyFileSync(new URL(`../${file}`, import.meta.url), join(dir, file))
      mkdirSync(join(dir, 'node_modules/next/dist/bin'), { recursive: true })
      symlinkSync(fileURLToPath(new URL('../node_modules/bs58', import.meta.url)), join(dir, 'node_modules/bs58'), 'dir')
      writeFileSync(join(dir, 'node_modules/next/dist/bin/next'), `
        const fs = require('node:fs');
        fs.mkdirSync('out', { recursive: true });
        fs.writeFileSync('out/effective-env.json', JSON.stringify(process.env));
      `)
      const file = join(dir, 'mainnet-pins.env')
      const run = args => spawnSync(process.execPath, [join(dir, 'scripts/build-release.mjs'), ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, NEXT_PUBLIC_NETWORK: 'testnet',
          NEXT_PUBLIC_APP_CONNECT_CARRIER: 'both', NETWORK: 'devnet', YAPPR_QA_BUILD: 'beta' },
      })
      writeEnv(file, completeMainnet())
      const good = run(['--mainnet', file])
      expect(good.status, good.stderr).toBe(0)
      const emitted = JSON.parse(readFileSync(join(dir, 'out/effective-env.json'), 'utf8'))
      expect(emitted.NEXT_PUBLIC_NETWORK).toBe('mainnet')
      expect(emitted.NETWORK).toBe('mainnet')
      expect(emitted.NEXT_PUBLIC_APP_CONNECT_CARRIER).toBe('dashpay')
      expect(emitted.YAPPR_QA_BUILD).toBeUndefined()
      rmSync(join(dir, 'out'), { recursive: true })
      for (const bad of [template, { ...completeMainnet(), NEXT_PUBLIC_YAPPR_CONTRACT_ID: read('.env.testnet').NEXT_PUBLIC_YAPPR_CONTRACT_ID },
        { ...completeMainnet(), NEXT_PUBLIC_MASTERNODE_VOTE_URL: read('.env.testnet').NEXT_PUBLIC_MASTERNODE_VOTE_URL }]) {
        writeEnv(file, bad)
        expect(run(['--mainnet', file]).status).toBe(1)
        expect(existsSync(join(dir, 'out'))).toBe(false)
      }
      writeEnv(join(dir, '.env.mainnet'), completeMainnet())
      expect(run(['--mainnet']).status).toBe(0)
      writeEnv(join(dir, '.env.testnet'), completeMainnet())
      expect(run([]).stderr).toContain('NEXT_PUBLIC_NETWORK=testnet')
      expect(run(['--mainnet', file, 'extra']).stderr).toContain('Usage:')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
