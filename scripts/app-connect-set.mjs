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
 *   member i    = generateId(maker, N + i)          i = 1, 2, …, in APP_CONNECT_ENTRIES order
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
import appConnectEntries from './app-connect-entries.cjs';
import { REPO_ROOT } from './derive-identities.mjs';

export const { APP_CONNECT_ENTRIES } = appConnectEntries;

/** The group the anchor registers: a single owner (the maker), no admins. */
export const APP_CONNECT_GROUP = {
  name: 'Yappr',
  description: 'Yappr (yap.pr): the contracts a Yappr App Connect key signs for',
};

const REHEARSAL_REPLACEMENTS = { social: 'socialV18', blog: 'blogV10', storefront: 'storefrontV11' };
const REHEARSAL_ENTRIES = [
  ...APP_CONNECT_ENTRIES.map((entry) => REHEARSAL_REPLACEMENTS[entry.name]
    ? { ...entry, envKey: null, replacedBy: REHEARSAL_REPLACEMENTS[entry.name] }
    : entry),
  { name: 'socialV18', file: 'yappr-social-contract-v18.json', envKey: 'NEXT_PUBLIC_YAPPR_CONTRACT_ID', sha256: '71e4d4b3353965cf343448e254150d0a4ff183a17384d53c437b4c6eefb6604d' },
  { name: 'blogV10', file: 'yappr-blog-contract-v10.json', envKey: 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID', sha256: '8a169b979ff6e138035ff7aabc0e226b626d59ae64d5edfffddc44cc617d4159' },
  { name: 'storefrontV11', file: 'yappr-storefront-contract-v11.json', envKey: 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID', sha256: '645a51a475a33794d713e23d9b27fd9a54531920e61c37e8e34c74b46f70b167' },
];

/**
 * The last entry testnet's group already holds (registered 2026-10-21 at
 * maker nonces 57-64, docs/TESTNET_RELEASE.md). A testnet run passes it as
 * `--append-after` with `--testnet-set rehearsal` to create the experimental
 * entries after it; the release set itself has nothing to append.
 */
export const TESTNET_REGISTERED_THROUGH = 'passkeyVault';

/**
 * Testnet's other set: the D36 staging rehearsal (docs/TESTNET_STAGING_REHEARSAL.md),
 * with its own maker, anchor and group, registered on 2026-10-18 at maker
 * nonces 1-8 and seeded with demo data. A run appends to it only when it names
 * it (`--testnet-set rehearsal`), and then only with this maker, anchor nonce
 * and group. Its eight entries, the same ones through
 * {@link TESTNET_REGISTERED_THROUGH}, were created from earlier cuts of the
 * same files: `registered` pins the sha256 its journal recorded for each.
 */
export const TESTNET_REHEARSAL_SET = {
  makerId: 'At8Xd9BpbVbzxvrna2smE3GbACeTaxf7YGUEwn7FHUZF',
  startNonce: 1n,
  groupId: 'ePtSmVdSqxJESyegxxRGcS7CwznyWSAn2FULYow8Dks',
  registered: {
    app: 'd3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41',
    social: 'b21d61f7cbfe37d5b784bae52884c9ac0db42b87a97152d2a1519c7c2f605bcf',
    blocks: 'ba0ef67a458cae5c702612a096a6b71fb0098fa370b3861da6da735dd80d3677',
    dmV5: '4fe2b3f46447d8aff30efcafc0e6235bee97724e34e7c96130951a59b0037c21',
    blog: 'a03012221e543b850d7524b27148e6b9c2b84fae3a0c291426e22de30d6dccef',
    pollr: 'a77afe5f27ad97d80e530551bbd5561ab02b1c622698b1a583a4893b03bd2347',
    storefront: '581122bbf27b76ed014c2695e6c84d4dc14a9712c9c6fb97f9f3614a4455bdca',
    passkeyVault: '14094cadcaf6c9b575fcb97ea53b769c5b0d88cfa99b3c5c827da0ab176f73c5',
  },
};

/**
 * The rehearsal set's eleven-entry plan for its maker and anchor nonce. A registered entry whose file has changed since (social v17, blog
 * v9, storefront v10) carries the sha256 it was created from and
 * `earlierCut: true`, so an append proves it on chain by id, owner and
 * membership rather than against today's file; the others are proved against
 * their files as usual. Throws unless `startNonce` is the rehearsal anchor's
 * and the derived group is the rehearsal's.
 */
export function planRehearsalSet({ startNonce, generateId }) {
  const { makerId, groupId, registered } = TESTNET_REHEARSAL_SET;
  if (BigInt(startNonce) !== TESTNET_REHEARSAL_SET.startNonce) throw new Error(`the rehearsal set's anchor is at maker nonce ${TESTNET_REHEARSAL_SET.startNonce}, not ${startNonce}`);
  const plan = planSet(REHEARSAL_ENTRIES, { makerId, startNonce, generateId });
  if (plan.groupId !== groupId) throw new Error(`the rehearsal anchor derives group ${plan.groupId}, not ${groupId}`);
  const contracts = plan.contracts.map((c) => (registered[c.name] && registered[c.name] !== c.sha256 ? { ...c, sha256: registered[c.name], earlierCut: true } : c));
  return { ...plan, anchor: contracts[0], contracts };
}

/**
 * The entries a run creates: those after `appendAfter` (the last entry the
 * group already holds), or every entry when it is null. Throws on an unknown
 * name, and when nothing would be left to create.
 */
export function entriesToCreate(entries, appendAfter) {
  if (appendAfter === null || appendAfter === undefined) return entries;
  const index = entries.findIndex((entry) => entry.name === appendAfter);
  if (index === -1) throw new Error(`--append-after ${appendAfter}: not an entry (${entries.map((entry) => entry.name).join(', ')})`);
  if (index === entries.length - 1) throw new Error(`--append-after ${appendAfter}: it is the last entry, so there is nothing to append`);
  return entries.slice(index + 1);
}

/**
 * Contracts that are NOT registered on a PV ≥ 14 network and never join the
 * group (docs/APP_CONNECT_CONTRACTS.md, "Retired on PV14").
 */
export const RETIRED_ON_PV14 = [
  'key-exchange-v2.json',
  'yappr-vault-contract.json',
  'encrypted-key-backup-contract.json',
  'yappr-dm-contract.json',
  // The password-era auth vault (R-M6, D10): the release set carries none; the passkey vault replaces it.
  'yappr-auth-vault-contract.json',
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
export function planAppConnectSet(options) {
  return planSet(APP_CONNECT_ENTRIES, options);
}

function planSet(entries, { makerId, startNonce, generateId }) {
  const start = BigInt(startNonce);
  if (start < 1n) throw new Error('the anchor nonce must be at least 1 (an identity\'s first create uses nonce 1)');
  const contracts = entries.map((entry, index) => {
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
 * (the pinned member list includes the anchor and every replaced member),
 * then each member's own contract variable (none for a replaced member). The
 * anchor's own variable is the first line.
 */
export function appConnectEnvLines({ appId, groupId, groupOwner, contracts }) {
  return [
    `${APP_CONNECT_ENV.appId}=${appId}`,
    `${APP_CONNECT_ENV.groupId}=${groupId}`,
    `${APP_CONNECT_ENV.groupOwner}=${groupOwner}`,
    `${APP_CONNECT_ENV.members}=${contracts.map((c) => c.id).join(',')}`,
    ...contracts.filter((c) => c.envKey && c.envKey !== APP_CONNECT_ENV.appId).map((c) => `${c.envKey}=${c.id}`),
  ];
}
