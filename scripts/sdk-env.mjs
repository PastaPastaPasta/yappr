/**
 * Shared network selection for the operational scripts in this directory.
 *
 * Every script used to hardcode `EvoSDK.testnetTrusted(...)`. They now go through
 * `connectSdk()`, which keeps testnet as the default and adds devnet support:
 *
 *   NETWORK=devnet node scripts/<script>.mjs
 *
 * On devnet every value comes from the environment first, then the checked-in
 * `.env.devnet` (`DEVNET_NAME` / `NEXT_PUBLIC_DEVNET_NAME`, `DAPI_ADDRESSES` /
 * `NEXT_PUBLIC_DAPI_ADDRESSES`, `QUORUM_URL` / `NEXT_PUBLIC_QUORUM_URL`,
 * `INSIGHT_URL` / `NEXT_PUBLIC_INSIGHT_API_URL`) — the same wiring the /devnet
 * build uses. There is no built-in devnet: a missing name or address pool is
 * an error, never a silent fallback to a retired network. `devnetConfig()` is
 * the one reader every script's devnet SDK goes through.
 *
 * Devnet notes (first verified against moutai on 2026-08-27; bonsia since 4.2.0-beta.7):
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

const INSIGHT_URLS = {
  testnet: 'https://insight.testnet.networks.dash.org/insight-api',
  mainnet: 'https://insight.dash.org/insight-api',
};

/**
 * Environment lookup that also consults the checked-in `.env.devnet`, so the
 * devnet wiring does not have to be repeated on every command line.
 */
export function envValue(name) {
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
  const net = network();
  const url = envValue('INSIGHT_URL')
    ?? envValue('NEXT_PUBLIC_INSIGHT_API_URL')
    ?? INSIGHT_URLS[net];
  if (!url) throw new Error('NETWORK=devnet needs INSIGHT_URL or NEXT_PUBLIC_INSIGHT_API_URL (env or .env.devnet)');
  return url.replace(/\/$/, '');
}

/** The devnet's name as the SDK needs it (bonsia: `bonsia-g1`). Only meaningful when NETWORK=devnet. */
export function devnetName() {
  const name = envValue('DEVNET_NAME') ?? envValue('NEXT_PUBLIC_DEVNET_NAME');
  if (!name) throw new Error('NETWORK=devnet needs DEVNET_NAME or NEXT_PUBLIC_DEVNET_NAME (env or .env.devnet)');
  return name.trim();
}

/** Explicit DAPI address pool (`https://host:port`, a bare host gets https://), required on devnet. */
export function dapiAddresses() {
  const raw = envValue('DAPI_ADDRESSES') ?? envValue('NEXT_PUBLIC_DAPI_ADDRESSES') ?? '';
  return raw.split(',').map((address) => address.trim()).filter(Boolean)
    .map((address) => (address.includes('://') ? address : `https://${address}`));
}

/**
 * The devnet the scripts target: `{ devnetName, addresses, quorumUrl }`, from
 * the environment or `.env.devnet`. Throws when the name or the address pool
 * is missing (a devnet publishes no masternode list to discover them from).
 * `quorumUrl` is null when unset: the SDK then prefetches quorum keys from
 * `https://quorums.<devnetName>.networks.dash.org`, which is WRONG for bonsia
 * (its devnetName is `bonsia-g1`, its quorum host `quorums.bonsia…`), so
 * bonsia sets it.
 */
export function devnetConfig() {
  const addresses = dapiAddresses();
  if (addresses.length === 0) {
    throw new Error('NETWORK=devnet needs DAPI_ADDRESSES or NEXT_PUBLIC_DAPI_ADDRESSES (comma-separated https://host:port, env or .env.devnet)');
  }
  return { devnetName: devnetName(), addresses, quorumUrl: envValue('QUORUM_URL') ?? envValue('NEXT_PUBLIC_QUORUM_URL') ?? null };
}

// The wasm transport requests `https://host:1443//org.dash.platform…` (a doubled
// slash). A gateway that does not merge slashes (bonsia's) answers 404, which
// the SDK reports as a malformed response. The client works around it in
// lib/services/dapi-path-shim.ts; this is the same rewrite for node scripts:
// only requests to a configured DAPI origin whose path starts with
// `//org.dash.platform.` are collapsed to one slash.
const SHIM_ORIGINS = Symbol.for('yappr.dapiPathShim.origins');

function installDapiPathShim(addresses) {
  const origins = addresses.map((address) => { try { return new URL(address).origin; } catch { return null; } }).filter(Boolean);
  const installed = globalThis.fetch?.[SHIM_ORIGINS];
  if (installed) { for (const origin of origins) installed.add(origin); return; }
  if (typeof globalThis.fetch !== 'function' || origins.length === 0) return;
  const rewritten = new Set(origins);
  const original = globalThis.fetch.bind(globalThis);
  const fixed = (url) => {
    try {
      const parsed = new URL(url);
      if (!rewritten.has(parsed.origin) || !parsed.pathname.startsWith('//org.dash.platform.')) return null;
      return `${parsed.origin}${parsed.pathname.slice(1)}${parsed.search}`;
    } catch {
      return null;
    }
  };
  const wrapped = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = fixed(url);
    if (target === null) return original(input, init);
    if (!(input instanceof Request)) return original(target, init);
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    return original(new Request(target, { method: input.method, headers: input.headers, body: hasBody ? await input.arrayBuffer() : undefined, signal: input.signal }), init);
  };
  wrapped[SHIM_ORIGINS] = rewritten;
  globalThis.fetch = wrapped;
}

/**
 * A trusted devnet SDK (not connected) for `config` (default: `devnetConfig()`).
 * Trusted mode is mandatory: wasm-sdk panics on `proofs: false` and refuses
 * non-trusted proof verification, so quorum keys are prefetched.
 */
export function devnetSdk({ timeoutMs = DEFAULT_SDK_TIMEOUT_MS, config = devnetConfig() } = {}) {
  installDapiPathShim(config.addresses);
  return new EvoSDK({
    network: 'devnet',
    devnetName: config.devnetName,
    addresses: config.addresses,
    trusted: true,
    ...(config.quorumUrl ? { quorumUrl: config.quorumUrl } : {}),
    settings: { timeoutMs },
  });
}

/** Builds the SDK for the selected network without connecting it. */
export function buildSdk({ timeoutMs = DEFAULT_SDK_TIMEOUT_MS, net: override } = {}) {
  const net = network(override);
  const settings = { timeoutMs };

  if (net === 'mainnet') return EvoSDK.mainnetTrusted({ settings });
  if (net === 'testnet') return EvoSDK.testnetTrusted({ settings });
  return devnetSdk({ timeoutMs });
}

/** Builds and connects the SDK, logging which network was reached. */
export async function connectSdk(options) {
  const net = network(options?.net);
  const sdk = buildSdk({ ...options, net });
  await sdk.connect();
  console.log(net === 'devnet' ? `connected to devnet ${devnetName()}` : `connected to ${net}`);
  return sdk;
}
