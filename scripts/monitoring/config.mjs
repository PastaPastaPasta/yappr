import bs58 from 'bs58';
import { parseAppConnectPins } from '../../lib/app-connect/pins.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

// D20: /staging builds the staging checkout from the same release file as root.
export const NETWORKS = { production: '.env.testnet', staging: '.env.testnet', testing: '.env.testing', devnet: '.env.devnet' };
export const SITES = [
  { name: 'production', url: 'https://yap.pr/', network: 'production', source: 'master' },
  { name: 'testing', url: 'https://yap.pr/testing/', network: 'testing', source: 'master' },
  { name: 'staging', url: 'https://yap.pr/staging/', network: 'staging', source: 'staging' },
  { name: 'devnet', url: 'https://yap.pr/devnet/', network: 'devnet', source: 'staging' },
  { name: 'mirror', url: 'https://yappr.pages.dev/', network: 'production', source: 'master' },
];

function isIdentifier(id) {
  try { return bs58.decode(id).length === 32; } catch { return false; }
}

export function appConnectConfig(env) {
  const configured = { appId: env.NEXT_PUBLIC_APP_CONNECT_APP_ID, groupId: env.NEXT_PUBLIC_APP_CONNECT_GROUP_ID, groupOwner: env.NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER, members: env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS };
  if (!Object.values(configured).some(value => value?.trim())) return null;
  const pins = parseAppConnectPins(configured);
  if (!pins) throw new Error('Invalid App Connect pins: require valid app/group/owner ids, unique members, positive versions and the anchor among members');
  return pins;
}

export function contractPins(env) {
  const pins = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NEXT_PUBLIC_') && (key.endsWith('_CONTRACT_ID') || key === 'NEXT_PUBLIC_APP_CONNECT_APP_ID') && value) pins.set(value, undefined);
  }
  const group = appConnectConfig(env);
  for (const member of group?.members ?? []) pins.set(member.contractId, member.version);
  for (const id of pins.keys()) if (!isIdentifier(id)) throw new Error(`Invalid contract id: ${id}`);
  return pins;
}

export function readNetwork(root, name) {
  const file = NETWORKS[name];
  if (!file) throw new Error(`Unknown monitoring network: ${name}`);
  const path = join(root, file);
  if (!existsSync(path)) return { name, skip: `${file} does not exist; release not registered` };
  const raw = parseEnv(readFileSync(path, 'utf8'));
  // Do not pass through arbitrary env values or credentials to artifacts/workers.
  const env = Object.fromEntries(Object.entries(raw).filter(([key]) => key.startsWith('NEXT_PUBLIC_') || key.endsWith('_MAKER_IDENTITY_ID')));
  const pins = [...contractPins(env)].map(([id, version]) => ({ id, ...(version ? { version } : {}) }));
  if (!pins.length) return { name, skip: `${file} contains no contract ids; release not registered` };
  return { name, env, pins, network: name === 'devnet' ? 'devnet' : 'testnet' };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function schemaHash(json) {
  return createHash('sha256').update(JSON.stringify(canonical(json))).digest('hex');
}

export function thresholds(env = process.env) {
  const configured = JSON.parse(env.MONITOR_THRESHOLDS || '{}');
  const defaults = { MAKER_MIN_CREDITS: 200e9, POT_MIN_CREDITS: 0, POT_MAX_CREDITS: 1e12, WINDOW_MINUTES: 30, POST_MAX: 1000, REPORT_MAX: 100, NODE_SAMPLE: 3, NODE_MIN: 2, MIN_PROTOCOL: 14, MAX_PROOF_AGE_SECONDS: 600 };
  const values = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = Number(env[`MONITOR_${key}`] || (configured[key] ?? fallback));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid MONITOR_${key}`);
    return [key, value];
  }));
  if (!values.WINDOW_MINUTES || values.NODE_MIN < 2 || values.NODE_SAMPLE < values.NODE_MIN || values.NODE_SAMPLE > 10 || !values.MAX_PROOF_AGE_SECONDS || values.POT_MAX_CREDITS < values.POT_MIN_CREDITS) throw new Error('Invalid monitoring window/node/pot/proof thresholds');
  return values;
}

export function contractRoles(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.endsWith('_CONTRACT_ID') || ['NEXT_PUBLIC_APP_CONNECT_APP_ID', 'NEXT_PUBLIC_APP_CONNECT_GROUP_ID', 'NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER', 'NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS'].includes(key)).map(([key, value]) => [key, key.endsWith('_GROUP_MEMBERS') ? value.split(',').map(pin => pin.trim()).filter(Boolean).sort().join(',') : value]));
}

// Expected browser connection settings for this deployment's intended network.
export function siteNetwork(env, network = 'testnet') {
  return { network, ...(network === 'devnet' ? {
    devnetName: env.NEXT_PUBLIC_DEVNET_NAME || 'moutai',
    addresses: (env.NEXT_PUBLIC_DAPI_ADDRESSES || '').split(',').map(address => address.trim()).filter(Boolean),
    quorumUrl: env.NEXT_PUBLIC_QUORUM_URL || '',
  } : {}) };
}

// Defaults match the owning browser configuration functions. Explicit settings
// are compared verbatim so an unsupported/misapplied selection cannot pass.
export function siteTopologies(env = {}) {
  const defaults = { NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v2', NEXT_PUBLIC_DM_TOPOLOGY: 'v3', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v1', NEXT_PUBLIC_BLOG_TOPOLOGY: 'v1', NEXT_PUBLIC_PROFILE_TOPOLOGY: 'v1', NEXT_PUBLIC_POLLR_TOPOLOGY: 'v3' };
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, env[key] || fallback]));
}
