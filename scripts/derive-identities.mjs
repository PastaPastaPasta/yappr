/**
 * Deterministic derivation of the e2e bot identity keys from a single BIP39 seed.
 *
 * Used as a library by the other scripts in this directory and by the Playwright
 * fixtures; the mnemonic itself lives in `E2E_SEED_PHRASE` (env or `.env.local`,
 * both gitignored) and in the `E2E_SEED_PHRASE` GitHub Actions secret.
 *
 * Determinism contract: the same mnemonic always yields the same WIFs, so a bot
 * identity can be re-derived at any time from the seed alone. Identity IDs are
 * NOT derivable (they come from the asset-lock outpoint), which is why they are
 * recorded in `.env.testing` as `E2E_IDENTITY_IDS`.
 *
 * Nothing here ever prints private key material unless `--reveal` is passed.
 *
 * Run:  node scripts/derive-identities.mjs <identityIndex> [--reveal]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import bs58check from 'bs58check';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Testnet WIF version byte; `0x01` suffix marks the key as compressed. */
const WIF_VERSION_TESTNET = 0xef;

/**
 * Key layout of every bot identity. Purposes/security levels match the Dash
 * Platform identity key semantics the app expects: writes are signed with an
 * AUTHENTICATION key at CRITICAL or HIGH.
 */
export const KEY_ROLES = [
  { keyIndex: 0, purpose: 'AUTHENTICATION', securityLevel: 'MASTER' },
  { keyIndex: 1, purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL' },
  { keyIndex: 2, purpose: 'AUTHENTICATION', securityLevel: 'HIGH' },
  { keyIndex: 3, purpose: 'TRANSFER', securityLevel: 'CRITICAL' },
  { keyIndex: 4, purpose: 'ENCRYPTION', securityLevel: 'MEDIUM' },
];

export const KEY_TYPE = 'ECDSA_SECP256K1';

/** Key id of the AUTHENTICATION/CRITICAL key — the one that signs state transitions. */
export const CRITICAL_AUTH_KEY_ID = 1;

/**
 * Minimal `KEY=value` parser for the repo's dotenv files. Good enough for the
 * flat, quote-optional files we control; deliberately not a full dotenv clone.
 */
export function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Reads the BIP39 mnemonic from `E2E_SEED_PHRASE`, falling back to `.env.local`.
 * Throws if it is missing or fails the checksum — never echoes the value.
 */
export function loadMnemonic() {
  const fromEnv = process.env.E2E_SEED_PHRASE ?? readEnvFile(join(REPO_ROOT, '.env.local')).E2E_SEED_PHRASE;
  const mnemonic = (fromEnv ?? '').trim().replace(/\s+/g, ' ');
  if (!mnemonic) {
    throw new Error('E2E_SEED_PHRASE is not set (checked the environment and .env.local)');
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('E2E_SEED_PHRASE is not a valid BIP39 mnemonic (checksum failed)');
  }
  return mnemonic;
}

/** App-specific, hardened derivation path. Stable by fiat — no wallet compatibility requirement. */
export function derivationPath(identityIndex, keyIndex) {
  return `m/9'/1'/5'/0'/${identityIndex}'/${keyIndex}'`;
}

/** Encodes a raw 32-byte private key as a compressed testnet WIF. */
export function privateKeyToWif(privateKeyBytes) {
  if (privateKeyBytes?.length !== 32) {
    throw new Error(`Expected a 32-byte private key, got ${privateKeyBytes?.length}`);
  }
  const payload = new Uint8Array(34);
  payload[0] = WIF_VERSION_TESTNET;
  payload.set(privateKeyBytes, 1);
  payload[33] = 0x01;
  return bs58check.encode(payload);
}

/**
 * Derives the full key set for one bot identity.
 *
 * @returns Array of `{keyIndex, path, purpose, securityLevel, keyType, wif, publicKeyHex, publicKey}`.
 */
export function deriveIdentityKeys(identityIndex, mnemonic = loadMnemonic()) {
  if (!Number.isInteger(identityIndex) || identityIndex < 0) {
    throw new Error(`identityIndex must be a non-negative integer, got ${identityIndex}`);
  }
  const master = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  return KEY_ROLES.map((role) => {
    const path = derivationPath(identityIndex, role.keyIndex);
    const node = master.derive(path);
    if (!node.privateKey || !node.publicKey) {
      throw new Error(`Derivation produced no key material for ${path}`);
    }
    return {
      ...role,
      path,
      keyType: KEY_TYPE,
      wif: privateKeyToWif(node.privateKey),
      publicKey: node.publicKey,
      publicKeyHex: Buffer.from(node.publicKey).toString('hex'),
    };
  });
}

/** Convenience accessor for the key that signs state transitions. */
export function criticalAuthKey(keys) {
  const key = keys.find((k) => k.keyIndex === CRITICAL_AUTH_KEY_ID);
  if (!key) throw new Error(`No key with index ${CRITICAL_AUTH_KEY_ID} in the derived key set`);
  return key;
}

/** Reads `E2E_IDENTITY_IDS` from `.env.testing` (falling back to the environment). */
export function loadIdentityIds() {
  const raw = process.env.E2E_IDENTITY_IDS ?? readEnvFile(join(REPO_ROOT, '.env.testing')).E2E_IDENTITY_IDS ?? '';
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
}

// ---- CLI --------------------------------------------------------------------

function main(argv) {
  const reveal = argv.includes('--reveal');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const unknownFlags = argv.filter((arg) => arg.startsWith('--') && arg !== '--reveal');
  const identityIndex = Number(positional[0]);
  if (unknownFlags.length > 0 || positional.length !== 1 || !Number.isInteger(identityIndex) || identityIndex < 0) {
    if (unknownFlags.length > 0) console.error(`Unknown flag: ${unknownFlags[0]}`);
    console.error('Usage: node scripts/derive-identities.mjs <identityIndex> [--reveal]');
    process.exit(1);
  }

  const keys = deriveIdentityKeys(identityIndex);
  console.log(`identityIndex: ${identityIndex}`);
  for (const key of keys) {
    console.log(
      `  key ${key.keyIndex}  ${key.path}  ${key.purpose}/${key.securityLevel}  ${key.keyType}  pubkey=${key.publicKeyHex}`
    );
    if (reveal) console.log(`        wif=${key.wif}`);
  }
  if (!reveal) console.log('(private keys withheld — pass --reveal to print WIFs)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
