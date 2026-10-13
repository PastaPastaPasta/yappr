/**
 * Registration-day battery for the **App Connect contract set**
 * (docs/APP_CONNECT_CONTRACTS.md): the `yappr-app` anchor and the contract
 * group its create registered. Run it live once `register-app-connect-contracts.mjs
 * --live` has registered the set; nothing here registers a contract.
 *
 * Read-only cases (proved reads, no actor, no keys):
 *   g1  the group exists, is owned by the pinned GROUP_OWNER alone (no admins) and is named "Yappr"
 *   g2  the pinned members are exactly the group's members: none missing, no unexpected
 *       contract, and no document-type or token member
 *   g3  the anchor registered the group: APP_ID = generateId(owner, n) and
 *       GROUP_ID = contractGroupId(owner, n) for the same nonce n; every pinned member is
 *       owner-owned, lists the group among its memberships, and is still at version 1
 *       (an update could add a type every group key then signs for)
 *   a1  the anchor as deployed: `requiresIdentityEncryptionBoundedKey` 2
 *       (MultipleReferenceToLatest), no decryption opt-in, and the committed `appInfo`
 *       (owner-only creation), schema for schema
 * Write case (a seed-ledger persona with a MASTER key; adds two keys to it on every run):
 *   k1  an ENCRYPTION/MEDIUM key bound to the anchor registers, and
 *       `identities.contractKeys(anchor, ENCRYPTION)` returns it; a second one moves
 *       that latest pointer to itself, and the first stays enabled
 *
 *   NETWORK=devnet node scripts/verify-appconnect.mjs [--contract <APP_ID>] \
 *     [--group <GROUP_ID>] [--owner <GROUP_OWNER>] [--members <id,id,…>] [--keyholder 242] [--only g1,g2,g3,a1]
 *   node scripts/verify-appconnect.mjs --self-test   # offline: pins, the anchor's shape, the group id derivation
 *
 * The ids default to the NEXT_PUBLIC_APP_CONNECT_* variables the client pins:
 * from the environment, and on a devnet also from .env.devnet.
 */
import { readFileSync } from 'node:fs';
import { ContractBounds, DataContract, IdentityPublicKeyInCreation, IdentitySigner, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import {
  APP_CONNECT_ENTRIES, APP_CONNECT_ENV, APP_CONNECT_GROUP, RETIRED_ON_PV14, contractFilePath, contractGroupId, decideCreateOutcome,
  fileSha256, identityNonceSpent, sameSchemas,
} from './app-connect-set.mjs';
import { normalizeId, reportSelfTest, runBattery, settle } from './battery-lib.mjs';
import { envValue, network } from './sdk-env.mjs';
import { NONCE_SEQUENCE_MASK, describeErr, generateKeypairHex, ledgerEntry, loadLedger, wifFromHex } from './seed/seed-lib.mjs';

const MASTER_KEY_ID = 0;
const ENCRYPTION = 1;
/** MultipleReferenceToLatest (rs-dpp StorageKeyRequirements): bound keys keep a "current key" pointer. */
const REFERENCE_TO_LATEST = 2;
/** OwnerOnly (rs-dpp CreationRestrictionMode): only the contract owner creates. */
const OWNER_ONLY = 1;
/** Sakura's 2026-10-08 group: contractGroupId(maker, 1), as registered on chain. */
const GROUP_ID_VECTOR = ['9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH', 1n, 'Cxxdiq5bBMFr2j8H1ug4hKaDqv7CcVYMt8PPvopj2rDF'];

const anchorEntry = APP_CONNECT_ENTRIES[0];
const anchorFile = () => JSON.parse(readFileSync(contractFilePath(anchorEntry.file), 'utf8'));
const idList = (value) => (value ?? '').split(',').map((id) => id.trim()).filter(Boolean);

/** A key's public-key bytes, whichever shape the SDK hands them back in. */
function keyBytes(key) {
  const data = key.toObject().data;
  if (typeof data === 'string') return Buffer.from(data, /^[0-9a-f]+$/i.test(data) ? 'hex' : 'base64');
  return Buffer.from(Array.isArray(data) ? data : Uint8Array.from(data));
}

/** Every page of one kind of member of the group. */
async function allMembers(battery, groupId, kind) {
  const members = [];
  let startAfter;
  do {
    const page = await battery.readback(() => battery.sdk.contractGroups.members({ contractGroupId: groupId, kind, limit: 100, ...(startAfter ? { startAfter } : {}) }));
    members.push(...(page[kind] ?? []));
    startAfter = page.nextStartAfter;
  } while (startAfter);
  return members;
}

const CASES = new Map();

CASES.set('g1', async ({ battery, pinned }) => {
  const info = await battery.readback(() => battery.sdk.contractGroups.info(pinned.groupId));
  battery.check('g1a the group exists', Boolean(info), pinned.groupId);
  if (!info) return;
  battery.check('g1b its owner is the pinned GROUP_OWNER', info.ownerId === pinned.owner, `owner ${info.ownerId}`);
  battery.check('g1c it has no admins (nobody but the owner can add a member)', info.adminIds.length === 0, `admins ${JSON.stringify(info.adminIds)}`);
  battery.check(`g1d it is named "${APP_CONNECT_GROUP.name}"`, info.name === APP_CONNECT_GROUP.name, `name ${info.name}, description ${info.description}`);
});

CASES.set('g2', async ({ battery, pinned }) => {
  const contracts = await allMembers(battery, pinned.groupId, 'contracts');
  const missing = pinned.members.filter((id) => !contracts.includes(id));
  const unexpected = contracts.filter((id) => !pinned.members.includes(id));
  battery.check('g2a every pinned member is a whole-contract member of the group', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${pinned.members.length} pinned`);
  battery.check('g2b the group has no member the app does not pin (the app blocks new logins on one)', unexpected.length === 0, unexpected.length ? `unexpected ${unexpected.join(', ')}` : `${contracts.length} members`);
  for (const kind of ['documentTypes', 'tokens']) {
    const partial = await allMembers(battery, pinned.groupId, kind);
    battery.check(`g2c the group has no ${kind} member`, partial.length === 0, JSON.stringify(partial));
  }
});

CASES.set('g3', async ({ battery, pinned }) => {
  const ownerNonce = ((await battery.readback(() => battery.sdk.identities.nonce(pinned.owner))) ?? 0n) & NONCE_SEQUENCE_MASK;
  let anchorNonce = null;
  for (let nonce = 1n; nonce <= ownerNonce && anchorNonce === null; nonce++) {
    if (DataContract.generateId(pinned.owner, nonce).toBase58() === pinned.appId) anchorNonce = nonce;
  }
  battery.check('g3a APP_ID is a create of GROUP_OWNER', anchorNonce !== null, anchorNonce === null ? `not generateId(owner, 1…${ownerNonce})` : `nonce ${anchorNonce}`);
  if (anchorNonce !== null) battery.check('g3b GROUP_ID was registered by that same create', contractGroupId(pinned.owner, anchorNonce) === pinned.groupId, `contractGroupId(owner, ${anchorNonce}) = ${contractGroupId(pinned.owner, anchorNonce)}`);
  battery.check('g3c the anchor is pinned as a member', pinned.members.includes(pinned.appId));
  for (const id of pinned.members) {
    const [contract, memberships] = await Promise.all([
      battery.readback(() => battery.sdk.contracts.fetch(id)),
      battery.readback(() => battery.sdk.contractGroups.forContract(id)),
    ]);
    battery.check(`g3d ${id} is owned by GROUP_OWNER and lists the group`, contract?.ownerId.toBase58() === pinned.owner && memberships.contract.includes(pinned.groupId),
      `owner ${contract?.ownerId.toBase58() ?? 'absent'}, groups ${JSON.stringify(memberships.contract)}`);
    // A whole-contract membership covers every type the contract will ever have, so an update
    // widens what every group key signs for without changing the member list.
    battery.check(`g3e ${id} is still at version 1 (no update has added a type to the group)`, contract?.version === 1, `version ${contract?.version}`);
  }
});

CASES.set('a1', async ({ battery, pinned }) => {
  const contract = await battery.readback(() => battery.sdk.contracts.fetch(pinned.appId));
  battery.check('a1a the anchor contract exists', Boolean(contract), pinned.appId);
  if (!contract) return;
  const pv = PlatformVersion.latest();
  const json = contract.toJSON(pv);
  battery.check('a1b requiresIdentityEncryptionBoundedKey is 2 (MultipleReferenceToLatest)', Number(json.config.requiresIdentityEncryptionBoundedKey) === REFERENCE_TO_LATEST, String(json.config.requiresIdentityEncryptionBoundedKey));
  battery.check('a1c no decryption-key opt-in', json.config.requiresIdentityDecryptionBoundedKey == null, String(json.config.requiresIdentityDecryptionBoundedKey));
  battery.check('a1d the document types are the committed file\'s, schema for schema', sameSchemas(json.documentSchemas, anchorFile().documentSchemas), Object.keys(json.documentSchemas).join(', '));
  battery.check('a1e appInfo is owner-only (creationRestrictionMode 1)', Number(contract.schemas.appInfo?.creationRestrictionMode) === OWNER_ONLY);
});

CASES.set('k1', async ({ battery, args, pinned }) => {
  const entry = ledgerEntry(loadLedger(), args.keyholder);
  const master = entry?.identityKeys.find((key) => key.keyId === MASTER_KEY_ID);
  if (!master) { battery.check('k1 keyholder has a MASTER key in the seed ledger', false, `persona ${args.keyholder}`); return; }
  const ownerId = entry.identityId;
  const currentKey = async () => {
    const result = await battery.readback(() => battery.sdk.identities.contractKeys({ identityIds: [ownerId], contractId: pinned.appId, purposes: [ENCRYPTION] }));
    const keys = result.find((r) => normalizeId(r.identityId) === ownerId)?.keys ?? [];
    return keys.length === 1 ? keys[0] : null;
  };
  /** An identity snapshot that already holds `key` (its id and public bytes); a lagging node may hand back an older one. */
  const snapshotHolding = async (key) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await settle();
      const identity = await battery.readback(() => battery.sdk.identities.fetch(ownerId));
      const held = identity.getPublicKeyById(key.keyId);
      if (held && keyBytes(held).equals(key.publicKey)) return identity;
    }
    throw new Error(`no identity snapshot holds key ${key.keyId} yet`);
  };
  /**
   * Submits one anchor-bound key. Returns the key it tried to add whatever the SDK
   * reports: a confirmation timeout can follow an update that landed, so the
   * chain read-back (`pointsAt`) decides, and `error` is only the detail.
   */
  const addAnchorKey = async (previous) => {
    // The update takes its key id and revision from this snapshot, so it must already hold the
    // previous step's key: a node one block behind would hand back the identity without it.
    const identity = previous ? await snapshotHolding(previous) : await battery.readback(() => battery.sdk.identities.fetch(ownerId));
    const keyId = identity.publicKeys.reduce((max, key) => Math.max(max, key.keyId), 0) + 1;
    const fresh = generateKeypairHex();
    const signer = new IdentitySigner();
    for (const hex of [master.privateKeyHex, fresh.privateKeyHex]) signer.addKeyFromWif(wifFromHex(hex));
    const key = new IdentityPublicKeyInCreation({
      keyId, purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1', isReadOnly: false,
      data: Uint8Array.from(Buffer.from(fresh.publicKeyHex, 'hex')), signature: new Uint8Array(0), contractBounds: ContractBounds.SingleContract(pinned.appId),
    });
    let error = null;
    try {
      await battery.sdk.identities.update({ identity, signer, addPublicKeys: [key] });
    } catch (e) {
      error = describeErr(e).slice(0, 220);
    }
    return { keyId, publicKey: Buffer.from(fresh.publicKeyHex, 'hex'), error };
  };
  /** Polls contractKeys until it names `want` (the update may take a block to show). */
  const pointsAt = async (want) => {
    let current = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      current = await currentKey();
      if (current && current.keyId === want.keyId && keyBytes(current).equals(want.publicKey)) return { ok: true, current };
      await settle();
    }
    return { ok: false, current };
  };
  /** Adds one anchor-bound key and checks contractKeys names it; the added key, or null on a failure. */
  const step = async (label, which, previous) => {
    let added;
    try {
      added = await addAnchorKey(previous);
    } catch (e) {
      battery.check(`${label} ${which} anchor-bound ENCRYPTION key registers`, false, describeErr(e).slice(0, 220));
      return null;
    }
    const { ok, current } = await pointsAt(added);
    const detail = `${current ? `current key ${current.keyId}` : 'no current key'}${added.error ? `; the SDK reported: ${added.error}` : ''}`;
    battery.check(`${label} ${which} anchor-bound ENCRYPTION key (id ${added.keyId}) registers and contractKeys(anchor) returns it as the latest`, ok, detail);
    return ok ? added : null;
  };

  const first = await step('k1a', 'a first');
  const second = first && await step('k1b', 'a second', first);
  if (!second) return;
  // Judged on a snapshot that already holds the second key, so it shows the identity after the rotation.
  let identity;
  try {
    identity = await snapshotHolding(second);
  } catch (e) {
    battery.check('k1c the superseded key stays enabled and anchor-bound', false, describeErr(e).slice(0, 220));
    return;
  }
  const stored = identity.getPublicKeyById(first.keyId);
  battery.check('k1c the superseded key stays enabled and anchor-bound (latest is a pointer, not a revocation)',
    Boolean(stored) && stored.disabledAt === undefined && normalizeId(stored.contractBounds?.identifier) === pinned.appId,
    stored ? `disabledAt ${stored.disabledAt}, bound to ${normalizeId(stored.contractBounds?.identifier)}` : 'missing');
});

/**
 * The publisher's refusal decision (register-app-connect-contracts.mjs `createOutcome`), on
 * hand-built proofs: only a spent nonce plus a membership proof at least as new as it, without
 * the group, is a refusal. Raw nonces follow rs-dpp: bit 40 + k - 1 marks `top - k` still unused.
 */
function publisherDecisionCases() {
  const GROUP = 'group';
  const gap = (top, ...missing) => missing.reduce((raw, n) => raw | (1n << (top - n - 1n + 40n)), top);
  const outcome = (rawNonce, groupIds, membershipHeight, nonceHeight = 100n) => decideCreateOutcome({ rawNonce, nonceHeight, nonce: 13n, groupIds, membershipHeight, groupId: GROUP });
  return [
    ['nonce 13 at the top is spent', identityNonceSpent(13n, 13n)],
    ['nonce 13 below a later top, with no gap, is spent', identityNonceSpent(14n, 13n)],
    ['nonce 13 flagged missing below top 14 may still land', !identityNonceSpent(gap(14n, 13n), 13n)],
    ['a gap at 12 says nothing about 13', identityNonceSpent(gap(14n, 12n), 13n)],
    ['nonce 13 above top 12 is not spent', !identityNonceSpent(12n, 13n)],
    ['more than 24 below the top can never be used again', identityNonceSpent(13n + 25n, 13n)],
    ['a create whose contract lists the group landed, whatever the nonce says', outcome(12n, [GROUP], 1n) === 'landed'],
    ['a still-missing nonce is pending, never refused', outcome(gap(14n, 13n), [], 200n) === 'pending'],
    ['a spent nonce and a membership proof as new as it, without the group: refused', outcome(14n, [], 100n) === 'refused'],
    ['a membership proof older than the nonce proof decides nothing', outcome(14n, [], 99n) === 'stale'],
  ];
}

function selfTestAppConnect() {
  const anchor = anchorFile();
  const appInfo = anchor.documentSchemas?.appInfo ?? {};
  const files = APP_CONNECT_ENTRIES.map((e) => e.file);
  return reportSelfTest('the App Connect contract set', [
    ...APP_CONNECT_ENTRIES.map((e) => [`${e.file} matches its pinned sha256`, fileSha256(e.file) === e.sha256]),
    ['the anchor is registered first', anchorEntry.name === 'app' && anchorEntry.file === 'yappr-app-contract.json'],
    ['each contract is registered once', new Set(files).size === files.length],
    ['each contract variable names one member (a replaced member has none)', (() => {
      const keys = APP_CONNECT_ENTRIES.map((e) => e.envKey).filter(Boolean);
      return new Set(keys).size === keys.length;
    })()],
    ['no retired contract joins the group', RETIRED_ON_PV14.every((file) => !files.includes(file))],
    ['the anchor opts encryption keys in as MultipleReferenceToLatest (2)', anchor.config?.requiresIdentityEncryptionBoundedKey === REFERENCE_TO_LATEST],
    ['the anchor asks for no decryption key', anchor.config?.requiresIdentityDecryptionBoundedKey === null],
    ['the anchor declares appInfo alone', JSON.stringify(Object.keys(anchor.documentSchemas ?? {})) === '["appInfo"]'],
    ['appInfo is owner-only (creationRestrictionMode 1), one per owner, never deleted', appInfo.creationRestrictionMode === OWNER_ONLY && appInfo.canBeDeleted === false
      && appInfo.indices?.length === 1 && appInfo.indices[0].unique === true && JSON.stringify(appInfo.indices[0].properties) === '[{"$ownerId":"asc"}]'],
    ['contractGroupId matches the group sakura registered (rs-dpp generate_contract_group_id)', contractGroupId(GROUP_ID_VECTOR[0], GROUP_ID_VECTOR[1]) === GROUP_ID_VECTOR[2]],
    [`the group is named "${APP_CONNECT_GROUP.name}" with a description of at most 256 characters`, APP_CONNECT_GROUP.name.length <= 64 && APP_CONNECT_GROUP.description.length <= 256],
    ...publisherDecisionCases(),
  ]);
}

/** A variable from the environment, and on a devnet also from .env.devnet (never another network's file). */
const fromEnv = (name) => (network() === 'devnet' ? envValue(name) : process.env[name]) ?? '';
// runBattery defaults --contract from process.env alone; give it the devnet file's value too.
process.env[APP_CONNECT_ENV.appId] ||= fromEnv(APP_CONNECT_ENV.appId);

await runBattery({
  label: 'App Connect anchor',
  contract: { env: APP_CONNECT_ENV.appId },
  cases: CASES,
  flags: {
    group: fromEnv(APP_CONNECT_ENV.groupId),
    owner: fromEnv(APP_CONNECT_ENV.groupOwner),
    members: fromEnv(APP_CONNECT_ENV.members),
    keyholder: 242,
  },
  validate: (args) => {
    for (const flag of ['group', 'owner', 'members']) if (!args[flag]) throw new Error(`pass --${flag} or set the NEXT_PUBLIC_APP_CONNECT_* variable`);
  },
  selfTest: selfTestAppConnect,
  setup: async ({ args, contractId }) => {
    await ensureInitialized();
    const pinned = { appId: contractId, groupId: args.group, owner: args.owner, members: idList(args.members) };
    console.log(`group ${pinned.groupId}, owner ${pinned.owner}, ${pinned.members.length} pinned member(s)`);
    return { pinned };
  },
});
