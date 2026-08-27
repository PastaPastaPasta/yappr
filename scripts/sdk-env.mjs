/**
 * Shared network selection for the operational scripts in this directory.
 *
 * Every script used to hardcode `EvoSDK.testnetTrusted(...)`. They now go through
 * `connectSdk()`, which keeps testnet as the default and adds devnet support:
 *
 *   NETWORK=devnet DEVNET_NAME=moutai \
 *   DAPI_ADDRESSES=https://seed-1.moutai.networks.dash.org:1443,… \
 *   QUORUM_URL=http://127.0.0.1:3000 \
 *   node scripts/<script>.mjs
 *
 * Devnet notes (verified against moutai on 2026-08-27, wasm-sdk 4.2.0-dev.2):
 *
 * - Addresses must be given explicitly. A devnet publishes no masternode list to
 *   discover them from, and `EvoSDK.devnetTrusted()` takes no `addresses`, so the
 *   typed constructor is used instead.
 * - Reads require a trusted context. `proofs: false` panics inside rs-sdk
 *   ("queries without proofs are not supported yet") and non-trusted proof
 *   verification is rejected ("Non-trusted mode is not supported in WASM"), so the
 *   quorum public keys have to be prefetched over HTTP. The default host
 *   `quorums.<devnetName>.networks.dash.org` does not resolve for moutai — point
 *   QUORUM_URL at a service exposing `/quorums`, `/previous` and `/masternodes`
 *   (`dashmate` can produce the data; see PLAN_DEVNET_STAGING.md).
 * - Address and WIF prefixes stay on testnet's: moutai's Insight even reports
 *   `"network":"testnet"`. `keyNetwork()` is what key material should use.
 */
import { EvoSDK } from '@dashevo/evo-sdk';
import { readEnvFile, REPO_ROOT } from './derive-identities.mjs';
import { join } from 'node:path';

const DEFAULT_SDK_TIMEOUT_MS = 30000;

/** Devnet defaults, so a bare `NETWORK=devnet` targets moutai. */
const MOUTAI = {
  devnetName: 'moutai',
  addresses: [1, 2, 3, 4, 5].map((n) => `https://seed-${n}.moutai.networks.dash.org:1443`),
  insightUrl: 'https://insight.moutai.networks.dash.org/insight-api',
};

const INSIGHT_URLS = {
  testnet: 'https://insight.testnet.networks.dash.org/insight-api',
  mainnet: 'https://insight.dash.org/insight-api',
};

/**
 * Environment lookup that also consults the checked-in `.env.devnet`, so the
 * devnet wiring does not have to be repeated on every command line.
 */
function envValue(name) {
  if (process.env[name]) return process.env[name];
  const fromFile = readEnvFile(join(REPO_ROOT, '.env.devnet'))[name];
  return fromFile || undefined;
}

/**
 * The network the SDK connects to: `testnet` (default), `mainnet` or `devnet`.
 * Pass `override` to name a network explicitly — scripts that publish to one
 * network while reading their source material from another need both.
 */
export function network(override) {
  const value = (override ?? process.env.NETWORK ?? 'testnet').trim();
  if (!['testnet', 'mainnet', 'devnet'].includes(value)) {
    throw new Error(`NETWORK must be testnet, mainnet or devnet (got "${value}")`);
  }
  return value;
}

/** The network whose address/WIF prefixes apply. Devnets reuse testnet's. */
export function keyNetwork() {
  return network() === 'mainnet' ? 'mainnet' : 'testnet';
}

/** Base URL of the Insight API for the selected network. */
export function insightUrl() {
  const override = envValue('INSIGHT_URL') ?? envValue('NEXT_PUBLIC_INSIGHT_API_URL');
  if (override) return override.replace(/\/$/, '');
  const net = network();
  return (net === 'devnet' ? MOUTAI.insightUrl : INSIGHT_URLS[net]).replace(/\/$/, '');
}

/** The devnet's name, e.g. `moutai`. Only meaningful when NETWORK=devnet. */
export function devnetName() {
  return envValue('DEVNET_NAME') ?? envValue('NEXT_PUBLIC_DEVNET_NAME') ?? MOUTAI.devnetName;
}

/** Explicit DAPI address pool, required on devnet. */
export function dapiAddresses() {
  const raw = envValue('DAPI_ADDRESSES') ?? envValue('NEXT_PUBLIC_DAPI_ADDRESSES');
  if (!raw) return network() === 'devnet' ? MOUTAI.addresses : [];
  return raw.split(',').map((address) => address.trim()).filter(Boolean);
}

/** Builds the SDK for the selected network without connecting it. */
export function buildSdk({ timeoutMs = DEFAULT_SDK_TIMEOUT_MS, net: override } = {}) {
  const net = network(override);
  const settings = { timeoutMs };

  if (net === 'mainnet') return EvoSDK.mainnetTrusted({ settings });
  if (net === 'testnet') return EvoSDK.testnetTrusted({ settings });

  const addresses = dapiAddresses();
  if (addresses.length === 0) {
    throw new Error('NETWORK=devnet needs DAPI_ADDRESSES (comma-separated https://host:port)');
  }
  const quorumUrl = envValue('QUORUM_URL') ?? envValue('NEXT_PUBLIC_QUORUM_URL');
  return new EvoSDK({
    network: 'devnet',
    devnetName: devnetName(),
    addresses,
    trusted: true,
    ...(quorumUrl ? { quorumUrl } : {}),
    settings,
  });
}

/** Builds and connects the SDK, logging which network was reached. */
export async function connectSdk(options) {
  const sdk = buildSdk(options);
  await sdk.connect();
  const net = network(options?.net);
  console.log(net === 'devnet' ? `connected to devnet ${devnetName()}` : `connected to ${net}`);
  return sdk;
}
