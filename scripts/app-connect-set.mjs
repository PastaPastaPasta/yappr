/**
 * The App Connect contract set as data (docs/APP_CONNECT_CONTRACTS.md): the
 * `yappr-app` anchor, which registers Yappr's contract group, and the member
 * contracts that join it, in registration order. No network access and no keys.
 *
 * Everything a registration produces follows from the maker and the anchor's
 * identity nonce N:
 *
 *   APP_ID      = generateId(maker, N)              the anchor contract, the App Connect app id
 *   GROUP_ID    = contractGroupId(maker, N)         registered by the anchor's own create
 *   GROUP_OWNER = maker
 *   member i    = generateId(maker, N + i)          i = 1 … 7, in APP_CONNECT_ENTRIES order
 *
 * APP_ID and GROUP_ID depend on N alone. A member's id is only N + i when
 * nothing else spends a maker nonce in between; the publisher's journal
 * records where each one actually landed.
 *
 * Each source file is pinned by sha256: the publisher refuses a file that
 * changed after review, and `verify-appconnect.mjs --self-test` fails until a
 * re-cut updates its pin here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { REPO_ROOT } from './derive-identities.mjs';

/** The group the anchor registers: a single owner (the maker), no admins. */
export const APP_CONNECT_GROUP = {
  name: 'Yappr',
  description: 'Yappr (yap.pr): the contracts a Yappr App Connect key signs for',
};

/**
 * In nonce order: the anchor first (it registers the group and joins it), then
 * every member. `envKey` is the variable the deployment's id goes to.
 */
export const APP_CONNECT_ENTRIES = [
  { name: 'app', file: 'yappr-app-contract.json', envKey: 'NEXT_PUBLIC_APP_CONNECT_APP_ID', sha256: 'd3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41' },
  { name: 'social', file: 'yappr-social-contract-v15.json', envKey: 'NEXT_PUBLIC_YAPPR_CONTRACT_ID', sha256: 'd2e729005ce68688a7663c605efa37f979321d0b0a5e5c417fd03b12ce179859' },
  { name: 'blocks', file: 'yappr-blocks-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID', sha256: 'ba0ef67a458cae5c702612a096a6b71fb0098fa370b3861da6da735dd80d3677' },
  { name: 'dmV5', file: 'yappr-dm-contract-v5.json', envKey: 'NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID', sha256: '4fe2b3f46447d8aff30efcafc0e6235bee97724e34e7c96130951a59b0037c21' },
  { name: 'blog', file: 'yappr-blog-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID', sha256: '0b7d68391b9444b01787f343436b79635dae06b265d71e94f60d41486d0ac30f' },
  { name: 'pollr', file: 'pollr-contract.json', envKey: 'NEXT_PUBLIC_POLLR_CONTRACT_ID', sha256: '75a9deec439a7cb8d24f9ceb386a0d2afb24b9e1639134654aff7b92ffd9a846' },
  { name: 'storefront', file: 'yappr-storefront-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID', sha256: 'ab7cd33354b63c691e1780acc3713507d3f375684d2d90b7c58910d2009ad94d' },
  { name: 'authVault', file: 'yappr-auth-vault-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_AUTH_VAULT_CONTRACT_ID', sha256: 'cecf0ccca95ab0aff76ccf3142405dadd84c8f4c662419a727c0fa157f9738dd' },
];

/**
 * Contracts that are NOT registered on a PV ≥ 14 network and never join the
 * group (docs/APP_CONNECT_CONTRACTS.md, "Retired on PV14").
 */
export const RETIRED_ON_PV14 = [
  'key-exchange-v2.json',
  'yappr-vault-contract.json',
  'encrypted-key-backup-contract.json',
  'yappr-dm-contract.json',
];

/** The env names the client reads the set from (docs/APP_CONNECT_CONTRACTS.md). */
export const APP_CONNECT_ENV = {
  appId: 'NEXT_PUBLIC_APP_CONNECT_APP_ID',
  groupId: 'NEXT_PUBLIC_APP_CONNECT_GROUP_ID',
  groupOwner: 'NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER',
  members: 'NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

/** The sha256 of some bytes, as hex (what `APP_CONNECT_ENTRIES` pins). */
export const sha256Hex = (bytes) => sha256(bytes).toString('hex');

export const contractFilePath = (file) => join(REPO_ROOT, 'contracts', file);

/** The sha256 of a contract file's bytes, as hex. */
export const fileSha256 = (file) => sha256Hex(readFileSync(contractFilePath(file)));

/**
 * rs-dpp `identity_nonce.rs`: an identity nonce keeps the highest nonce used in
 * its low 40 bits, and above them a bitset of the up-to-24 nonces below it that
 * are still unused (bit 40 + k - 1 set: nonce `top - k` may still land).
 */
const NONCE_VALUE_MASK = (1n << 40n) - 1n;
const MAX_MISSING_NONCES = 24n;

/** Whether `nonce` can no longer be used: at or below the top, and not one of the still-missing ones. */
export function identityNonceSpent(rawNonce, nonce) {
  const raw = BigInt(rawNonce);
  const wanted = BigInt(nonce);
  const top = raw & NONCE_VALUE_MASK;
  if (wanted > top) return false;
  const position = top - wanted;
  if (position === 0n || position > MAX_MISSING_NONCES) return true;
  return (raw & (1n << (position - 1n + 40n))) === 0n;
}

/**
 * What became of a create at `nonce`, from two proofs: the maker's raw nonce
 * (at `nonceHeight`) and the contract's group memberships (at
 * `membershipHeight`). Every create of the set writes its membership together
 * with the contract, so a membership proof at least as new as a proof that the
 * nonce is spent, that does not list the group, proves the create never landed.
 *   'landed' | 'pending' (the nonce may still be used) | 'refused' | 'stale' (the membership proof is older)
 */
export function decideCreateOutcome({ rawNonce, nonceHeight, nonce, groupIds, membershipHeight, groupId }) {
  if (groupIds.includes(groupId)) return 'landed';
  if (!identityNonceSpent(rawNonce, nonce)) return 'pending';
  return BigInt(membershipHeight) >= BigInt(nonceHeight) ? 'refused' : 'stale';
}

/** Deep copy with object keys sorted and BigInts as numbers, so two renderings of one schema compare equal. */
function canonical(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

/** Whether two `documentSchemas` renderings (a file's, a parsed or fetched contract's `toJSON`) declare the same types. */
export const sameSchemas = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * rs-dpp `generate_contract_group_id`: sha256d("contract_group" ‖ ownerId ‖
 * identityNonce as u64 big-endian). The group id is not on the wire; it is the
 * registering create's owner and nonce.
 */
export function contractGroupId(ownerId, identityNonce) {
  const owner = bs58.decode(ownerId);
  if (owner.length !== 32) throw new Error(`contractGroupId: ${ownerId} is not a 32-byte identifier`);
  const nonce = Buffer.alloc(8);
  nonce.writeBigUInt64BE(BigInt(identityNonce));
  return bs58.encode(sha256(sha256(Buffer.concat([Buffer.from('contract_group'), owner, nonce]))));
}

/**
 * The ids a registration from `makerId` starting at the anchor's identity
 * nonce `startNonce` produces when nothing else takes a maker nonce in between.
 * `generateId` is `DataContract.generateId` (passed in so this module needs no wasm).
 */
export function planAppConnectSet({ makerId, startNonce, generateId }) {
  const start = BigInt(startNonce);
  if (start < 1n) throw new Error('the anchor nonce must be at least 1 (an identity\'s first create uses nonce 1)');
  const contracts = APP_CONNECT_ENTRIES.map((entry, index) => {
    const nonce = start + BigInt(index);
    return { ...entry, nonce, id: generateId(makerId, nonce) };
  });
  return {
    anchor: contracts[0],
    appId: contracts[0].id,
    groupId: contractGroupId(makerId, start),
    groupOwner: makerId,
    contracts,
  };
}

/**
 * The env lines a set wires the client to: the four App Connect variables
 * (the pinned member list includes the anchor), then each member's own
 * contract variable. The anchor's own variable is the first line.
 */
export function appConnectEnvLines({ appId, groupId, groupOwner, contracts }) {
  return [
    `${APP_CONNECT_ENV.appId}=${appId}`,
    `${APP_CONNECT_ENV.groupId}=${groupId}`,
    `${APP_CONNECT_ENV.groupOwner}=${groupOwner}`,
    `${APP_CONNECT_ENV.members}=${contracts.map((c) => c.id).join(',')}`,
    ...contracts.filter((c) => c.envKey !== APP_CONNECT_ENV.appId).map((c) => `${c.envKey}=${c.id}`),
  ];
}
