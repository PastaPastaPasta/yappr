/**
 * Prepare and file one release charter. NETWORK is mandatory. See the charter
 * section of docs/TESTNET_RELEASE.md for the manifest and registration sequence.
 * --plan is offline; --dry-run and --watch only read; only --live broadcasts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import bs58 from 'bs58';
import * as w from '@dashevo/evo-sdk';
import { connectSdk, devnetName, keyNetwork } from './sdk-env.mjs';
import { directoryProblem, formatCredits, keyFileProblem, requireNetwork } from './registration-policy.mjs';
import { resolveKeyFileOwner } from './owner-keys.mjs';

const CHARTERS = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88';
const FUND = 50_000_000_000n;
const LEADER_MINIMUM = 51_000_000_000n;
const MEMBER_MINIMUM = 100_000_000n;
const NONCE_MASK = (1n << 40n) - 1n;
const json = (value) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n';
const hash = (value) => createHash('sha256').update(json(value)).digest('hex');
const idBytes = (id) => w.Identifier.fromBase58(id).toBytes();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function identityId(value) {
  try { return typeof value === 'string' && bs58.decode(value).length === 32; } catch { return false; }
}

/** Validate without touching keys or the network; placeholders are valid ids. */
export function validateManifest(input) {
  if (!['social', 'blog', 'storefront'].includes(input.contract)) throw new Error('contract must be social, blog or storefront');
  if (!identityId(input.targetContractId)) throw new Error('targetContractId must be a base58 contract id (the predicted id before registration)');
  const expected = input.expected;
  if (!expected || !identityId(expected.ownerId) || !['notYetUsable', 'contractOwner', 'noModeration'].includes(expected.interim)
    || !['joinWindow', 'voteWindow', 'challengeCoolDown'].every((k) => Number.isSafeInteger(expected[k]) && expected[k] >= 0)) throw new Error('expected must declare ownerId, joinWindow, voteWindow, challengeCoolDown and interim');
  const actors = [input.leader, ...(input.members ?? [])];
  if (!input.leader || !Array.isArray(input.members) || input.members.length < 2 || input.members.length > 15) throw new Error('provide a leader and 2 to 15 members; three members are recommended');
  for (const actor of actors) {
    if (!identityId(actor?.identityId)) throw new Error('every actor needs a base58 identityId');
    if (!actor.keyFile || !Number.isSafeInteger(actor.keyId) || actor.keyId < 0) throw new Error('every actor needs keyFile and a nonnegative keyId');
    if (!actor.masterKeyFile || !Number.isSafeInteger(actor.masterKeyId) || actor.masterKeyId < 0) throw new Error('every actor needs masterKeyFile and a nonnegative masterKeyId for preparation');
  }
  for (const member of input.members) if (member.message !== undefined && (typeof member.message !== 'string' || Buffer.byteLength(member.message) > 1023)) throw new Error('member message must be at most 1023 bytes');
  if (!Array.isArray(expected.documentTypes) || !expected.documentTypes.length || expected.documentTypes.some((type) => typeof type !== 'string' || !type.length)) throw new Error('expected.documentTypes must list the moderated document types');
  if (new Set(actors.map((a) => a.identityId)).size !== actors.length) throw new Error('leader and members must all be distinct');
  if (!Array.isArray(input.reasons) || !input.reasons.length || input.reasons.length > 16) throw new Error('provide 1 to 16 reasons');
  for (const reason of input.reasons) {
    if (!/^[A-Z]{3}$/.test(reason.code) || typeof reason.label !== 'string' || !reason.label.trim() || [...reason.label].length > 64) throw new Error('every reason needs a three-uppercase-letter code and a label');
  }
  for (const reason of input.reasons) if (reason.description !== undefined && (typeof reason.description !== 'string' || !reason.description.length || [...reason.description].length > 1024)) throw new Error('reason description must be 1 to 1024 characters');
  if (new Set(input.reasons.map((r) => r.code)).size !== input.reasons.length) throw new Error('reason codes must be unique');
  const split = input.rewardSplit ?? { leader: 40, equal: 30, actions: 30 };
  if (!['leader', 'equal', 'actions'].every((key) => Number.isInteger(split[key]) && split[key] >= 0 && split[key] <= 100) || split.leader + split.equal + split.actions !== 100) throw new Error('rewardSplit percentages must sum to 100');
  const share = input.moderatorsShare ?? 60;
  if (!Number.isInteger(share) || share < 0 || share > 100) throw new Error('moderatorsShare must be 0 to 100');
  if (typeof input.description !== 'string' || !input.description.trim() || Buffer.byteLength(input.description) > 4096) throw new Error('provide a charter description');
  return { ...input, rewardSplit: split, moderatorsShare: share };
}

export function charterOptions(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    config: { type: 'string' }, journal: { type: 'string' }, targets: { type: 'string' },
    plan: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, live: { type: 'boolean' }, watch: { type: 'boolean' },
    prepare: { type: 'boolean' }, production: { type: 'boolean' }, 'allow-mainnet': { type: 'boolean' },
    'wait-registration': { type: 'string', default: '0' },
  } });
  const network = requireNetwork(env.NETWORK);
  if (network === 'mainnet' && !values['allow-mainnet']) throw new Error('mainnet is refused unless --allow-mainnet is explicit');
  const modes = ['plan', 'dry-run', 'live', 'watch'].filter((mode) => values[mode]);
  if (modes.length !== 1) throw new Error('choose exactly one of --plan, --dry-run, --live or --watch');
  const mode = modes[0];
  if (mode !== 'watch' && !values.config) throw new Error('--config <manifest.json> is required');
  if (mode === 'watch' && !values.config && !values.targets) throw new Error('--watch needs --config or --targets social=<id>,blog=<id>,storefront=<id>');
  if (mode === 'live' && !values.journal) throw new Error('--live requires --journal in a private directory');
  if (mode === 'live' && network !== 'devnet' && !values.production) throw new Error('--live off devnet requires --production');
  if (values.prepare && mode !== 'live') throw new Error('--prepare belongs to --live');
  const waitSeconds = Number(values['wait-registration']);
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 86400) throw new Error('--wait-registration must be 0 to 86400 seconds');
  return { ...values, network, mode, waitSeconds };
}

export function manifestHash(manifest) {
  // Paths may change when restoring the protected release backup. Bind content
  // and signer key ids, not local filenames or JSON property order.
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
      .filter((key) => !['keyFile', 'masterKeyFile'].includes(key)).map((key) => [key, canonical(value[key])])) : value;
  return hash(canonical(manifest));
}

function privateFile(path) {
  const problem = keyFileProblem(lstatSync(path), process.getuid?.());
  if (problem) throw new Error(`${path}: ${problem}`);
}

/** Atomic, owner-only checkpoint; no private keys appear in console output. */
export function writeCheckpoint(path, value) {
  if (existsSync(path)) privateFile(path);
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, json(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`cannot parse JSON from ${path}`); }
}

function prepareDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const problem = directoryProblem(stat);
  if (problem || (process.getuid && stat.uid !== process.getuid())) throw new Error(`private journal directory required: ${path}${problem ? ` ${problem}` : ''}`);
}

function enabled(key) { return key.disabledAt === undefined || key.disabledAt === null; }
function boundKey(key, purpose, type) {
  const bounds = key.contractBounds?.toJSON();
  return enabled(key) && key.purpose === purpose && key.securityLevel === 'MEDIUM' && key.keyType === 'ECDSA_SECP256K1'
    && bounds?.$type === 'documentType' && bounds.id === CHARTERS && bounds.documentTypeName === type;
}

function assertKey(key, pk, security) {
  if (!key || !enabled(key) || key.purpose !== 'AUTHENTICATION' || key.securityLevel !== security || key.contractBounds) throw new Error(`need an enabled, unbound ${security} AUTHENTICATION key`);
  if (key.getPublicKeyHash() !== pk.getPublicKeyHash()) throw new Error('key file does not match the on-chain identity key');
}

async function actorFor(sdk, actor) {
  const load = (file, keyId) => {
    privateFile(resolve(file));
    const owner = resolveKeyFileOwner({ file, keyId });
    if (owner.ownerId !== actor.identityId) throw new Error('key file identity does not match the manifest');
    return w.PrivateKey.fromWIF(owner.wif);
  };
  const pk = load(actor.keyFile, actor.keyId);
  const identity = await sdk.identities.fetch(actor.identityId);
  if (!identity) throw new Error(`identity not found: ${actor.identityId}`);
  const identityKey = identity.getPublicKeyById(actor.keyId);
  assertKey(identityKey, pk, 'CRITICAL');
  return { ...actor, identity, identityKey, pk, loadMaster: () => {
    const master = load(actor.masterKeyFile, actor.masterKeyId);
    assertKey(identity.getPublicKeyById(actor.masterKeyId), master, 'MASTER');
    return master;
  } };
}

function document(type, owner, data) {
  return w.Document.fromObject({ $formatVersion: '0', $id: new Uint8Array(32), $ownerId: idBytes(owner),
    $dataContractId: idBytes(CHARTERS), $type: type, $revision: 1n, $entropy: randomBytes(32), ...data }, w.PlatformVersion.latest());
}

/** Never allocate below a write this journal has already proved. Nodes may lag. */
export async function nextNonce(sdk, state, owner) {
  const floor = Object.values(state.steps).reduce((highest, step) =>
    step.owner === owner && step.state === 'verified' && step.nonce && BigInt(step.nonce) > highest
      ? BigInt(step.nonce) : highest, 0n);
  for (let attempt = 0; attempt <= 12; attempt++) {
    const raw = await sdk.wasm.getIdentityContractNonce(owner, CHARTERS);
    const current = BigInt(raw ?? 0) & NONCE_MASK;
    if (current >= floor) return current + 1n;
    if (attempt < 12) await sleep(5000);
  }
  throw new Error('nonce reads remain behind this journal’s proved writes; retry after the node catches up (no new transition prepared)');
}

async function createStep(sdk, state, actor, type, data, fund = false) {
  const nonce = await nextNonce(sdk, state, actor.identityId);
  const doc = document(type, actor.identityId, data);
  if (fund) {
    const required = await sdk.documents.contestFundToJoin(doc);
    try { if (!required || BigInt(required.credits) !== FUND) throw new Error('contest fund differs from the reviewed 0.5 DASH budget; stop and review'); }
    finally { required?.free(); }
  }
  const create = new w.DocumentCreateTransition({ document: doc, identityContractNonce: nonce,
    ...(fund ? { prefundedVotingBalance: new w.PrefundedVotingBalance({ indexName: 'byTargetContract', credits: FUND }) } : {}) });
  const id = create.base.id.toBase58();
  const batch = w.BatchTransition.fromBatchedTransitions([new w.BatchedTransition(create.toDocumentTransition())], actor.identityId, 0);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce(nonce);
  st.sign(actor.pk, actor.identityKey);
  return { id, type, owner: actor.identityId, nonce: String(nonce), bytes: Buffer.from(st.toBytes()).toString('base64'), hash: st.hash(false), state: 'prepared' };
}

export async function existsStep(sdk, step, target) {
  if (step.type === 'electedCharter') {
    const state = await sdk.voting.contestedResourceVoteState({ dataContractId: CHARTERS, documentTypeName: 'electedCharter', indexName: 'byTargetContract',
      indexValues: [target], resultType: 'documentsAndVoteTally', includeLockedAndAbstaining: true,
      startAtContenderId: step.owner, startAtIncluded: true, limit: 1 });
    try {
      const contender = state.contenders.find((c) => c.identityId.toBase58() === step.owner);
      if (contender?.serializedDocument) {
        const contract = await sdk.contracts.fetch(CHARTERS);
        try {
          const doc = w.Document.fromBytes(contender.serializedDocument, contract, 'electedCharter', w.PlatformVersion.latest());
          try { return doc.id.toBase58() === step.id && doc.ownerId.toBase58() === step.owner; }
          finally { doc.free(); }
        } finally { contract.free(); }
      }
      const seated = await sdk.moderationCharters.seatedCharter(target);
      try { return seated?.id.toBase58() === step.id && seated?.ownerId.toBase58() === step.owner; }
      finally { seated?.free(); }
    } finally { state.free(); }
  }
  return Boolean(await sdk.documents.get(CHARTERS, step.type, step.id));
}

async function waitForStep(sdk, step, target) {
  for (let attempt = 0; attempt <= 12; attempt++) {
    try { if (await existsStep(sdk, step, target)) return true; } catch { /* proved reads can lag or fail; preserve signed bytes */ }
    if (attempt < 12) await sleep(5000);
  }
  return false;
}

export async function commitStep(sdk, state, name, save, make) {
  let step = state.steps[name];
  if (!step) { step = await make(); state.steps[name] = step; save(); }
  let alreadyProved = false;
  try { alreadyProved = await existsStep(sdk, step, state.targetContractId); } catch { /* a failed probe may only retry the same signed bytes */ }
  if (alreadyProved) {
    step.state = 'verified'; save(); console.log(`${name}: ${step.id} (proved on resume)`); return step;
  }
  // Only the journaled signed bytes are ever broadcast, including after a timeout.
  // Never build a fresh transition/nonce to retry an ambiguous create.
  if (step.state === 'verified') throw new Error(`${name}: previously verified document is missing; reconcile the journal`);
  if (step.nonce) {
    const current = BigInt(await sdk.wasm.getIdentityContractNonce(step.owner, CHARTERS) ?? 0) & NONCE_MASK;
    if (current >= BigInt(step.nonce)) {
      if (await waitForStep(sdk, step, state.targetContractId)) { step.state = 'verified'; save(); console.log(`${name}: ${step.id} (proved after nonce advance)`); return step; }
      throw new Error(`${name}: nonce already consumed but document not proved; reconcile the saved transition hash and document before continuing; never discard uncertain signed bytes`);
    }
  }
  step.state = 'broadcasting'; save();
  let broadcastError;
  try {
    const result = await sdk.stateTransitions.broadcastAndWait(w.StateTransition.fromBytes(Buffer.from(step.bytes, 'base64')));
    step.result = result?.toJSON?.() ?? null; save();
  }
  catch (error) { broadcastError = safeError(error); step.error = broadcastError; save(); }
  const proved = await waitForStep(sdk, step, state.targetContractId);
  if (!proved) throw new Error(`${name} not proved after 60s; retain the journal and inspect the saved error and transition hash. Reconcile a rejection before retrying; an uncertain outcome must only reuse the saved bytes${broadcastError ? `: ${broadcastError}` : ''}`);
  const status = await sdk.system.status();
  step.observedTip = status.toJSON().chain;
  status.free();
  step.state = 'verified'; delete step.error; save();
  console.log(`${name}: ${step.id} (proved)`);
  return step;
}

async function prepareBoundKey(sdk, actor, purpose, type, state, dir, save, prepare) {
  const name = `${actor.identityId}-${purpose.toLowerCase()}`;
  const file = resolve(dir, `${name}.json`);
  let identity = await sdk.identities.fetch(actor.identityId);
  let onChain = identity.publicKeys.find((k) => boundKey(k, purpose, type));
  if (!existsSync(file)) {
    if (!prepare) throw new Error(`${name}: missing prepared key file; run --live --prepare before registration`);
    if (onChain) throw new Error(`${name}: a bound key exists; supply its private half at ${file} before continuing`);
    const pk = w.PrivateKey.fromHex(randomBytes(32).toString('hex'), keyNetwork());
    const keyId = Math.max(...identity.publicKeys.map((k) => k.keyId)) + 1;
    writeCheckpoint(file, { identityId: actor.identityId, identityKeys: [{ id: keyId, privateKeyWif: pk.toWIF() }] });
  }
  privateFile(file);
  const saved = readJson(file);
  const keyId = saved.identityKeys[0].id;
  const owner = resolveKeyFileOwner({ file, keyId });
  if (owner.ownerId !== actor.identityId) throw new Error('bound key file belongs to another identity');
  const pk = w.PrivateKey.fromWIF(owner.wif);
  const byId = identity.getPublicKeyById(keyId);
  if (byId && (!boundKey(byId, purpose, type) || byId.getPublicKeyHash() !== pk.getPublicKeyHash())) throw new Error(`${name}: bound key id was occupied by a different key`);
  onChain = byId;
  if (!onChain) {
    if (!prepare) throw new Error(`${name}: key not proved; finish --live --prepare before filing`);
    const previous = state.keys[name];
    if (previous?.state === 'broadcasting') throw new Error(`${name}: identity update outcome unknown; inspect the proved identity before retrying (no automatic new nonce)`);
    const key = new w.IdentityPublicKeyInCreation({ keyId, purpose, securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1', isReadOnly: false,
      data: pk.getPublicKey().toBytes(), contractBounds: w.ContractBounds.SingleContractDocumentType(CHARTERS, type) });
    const signer = new w.IdentitySigner(); signer.addKey(actor.loadMaster()); signer.addKey(pk);
    state.keys[name] = { keyId, file, state: 'broadcasting' }; save();
    await sdk.identities.update({ identity, addPublicKeys: [key], signer });
    identity = await sdk.identities.fetch(actor.identityId);
    if (!identity.publicKeys.some((k) => k.keyId === keyId && boundKey(k, purpose, type) && k.getPublicKeyHash() === pk.getPublicKeyHash())) throw new Error(`${name}: new bound key could not be proved`);
  }
  state.keys[name] = { keyId, file, state: 'verified' }; save();
  return pk;
}

export async function balancesFor(sdk, manifest) {
  const actors = [manifest.leader, ...manifest.members];
  const balances = [];
  for (let i = 0; i < actors.length; i++) {
    const identity = await sdk.identities.fetch(actors[i].identityId);
    const balance = identity ? BigInt(identity.balance) : null;
    const required = i === 0 ? LEADER_MINIMUM : MEMBER_MINIMUM;
    balances.push({ identityId: actors[i].identityId, role: i === 0 ? 'leader' : 'member', balance: balance === null ? null : String(balance), required: String(required), ready: balance !== null && balance >= required });
  }
  return balances;
}

export function assertRegistered(contract, expected) {
  const moderators = contract.config.moderation?.moderators;
  if (moderators?.$type !== 'elected') throw new Error('registered target does not declare elected moderation');
  if (contract.ownerId.toBase58() !== expected.ownerId) throw new Error('registered owner disagrees with expected ownerId');
  for (const key of ['joinWindow', 'voteWindow', 'challengeCoolDown']) if (moderators[key] !== expected[key]) throw new Error(`registered ${key} disagrees with expected declaration`);
  if (JSON.stringify(Object.keys(moderators.moderatedDocumentTypes ?? {}).sort()) !== JSON.stringify([...expected.documentTypes].sort())) throw new Error('registered moderated document types disagree with expected declaration');
  if ((moderators.electionDelay ?? 0) !== 0) throw new Error('registered election delay is nonzero; this immediate release filer requires no delay');
  if (moderators.interim?.$type !== expected.interim) throw new Error('registered interim disagrees with expected declaration');
}

async function registered(sdk, target, waitSeconds, expected) {
  const deadline = Date.now() + waitSeconds * 1000;
  do {
    const contract = await sdk.contracts.fetch(target);
    if (contract) {
      const moderators = contract.config.moderation?.moderators;
      try { assertRegistered(contract, expected); } catch (error) { contract.free(); throw error; }
      console.log(`Registered ${target}: join ${moderators.joinWindow}s, vote ${moderators.voteWindow}s, interim ${moderators.interim.$type}`);
      return contract;
    }
    if (Date.now() >= deadline) break;
    await sleep(1500);
  } while (true);
  throw new Error('target is not registered; prepare before registration, then re-run --live immediately after it (or --wait-registration <seconds>)');
}

/** One read-only snapshot. Invoke again to refresh; never loads signing keys. */
export async function watchContract(sdk, name, target) {
  const contract = await sdk.contracts.fetch(target);
  if (!contract) return { contract: name, targetContractId: target, phase: 'not registered' };
  const rawDeclaration = contract.config.moderation?.moderators;
  if (rawDeclaration?.$type !== 'elected') throw new Error(`${name}: target is not elected`);
  const declaration = { ...rawDeclaration, joinWindow: rawDeclaration.joinWindow ?? 604800, voteWindow: rawDeclaration.voteWindow ?? 604800 };
  const proposals = await sdk.moderationCharters.submittedCharters({ targetContractId: target, limit: 100 });
  const team = await sdk.moderationCharters.team(target);
  const state = await sdk.voting.contestedResourceVoteState({ dataContractId: CHARTERS, documentTypeName: 'electedCharter', indexName: 'byTargetContract', indexValues: [target], resultType: 'documentsAndVoteTally', includeLockedAndAbstaining: true, limit: 100 });
  try {
    const contenders = state.contenders.map((c) => ({ identityId: c.identityId.toBase58(), votes: c.voteTally ?? null }));
    let endsAtMs = null;
    const status = await sdk.system.status();
    const chain = status.toJSON(); status.free();
    const chainMs = Number(chain.time?.block);
    // Start at the proved chain time so old completed polls cannot bury a
    // rival's live contest; bound future polls to the registered windows.
    const bounds = Number.isFinite(chainMs) ? { startTimeMs: BigInt(chainMs), startTimeIncluded: true,
      endTimeMs: chainMs + (declaration.joinWindow + declaration.voteWindow) * 1000 + 600000, endTimeIncluded: true } : {};
    let lower = {};
    for (let page = 0; !team && contenders.length > 0 && page < 10; page++) {
      const entries = await sdk.voting.votePollsByEndDate({ ...bounds, ...lower, orderAscending: true, limit: 100 });
      let first, last, count = 0;
      try {
        for (const entry of entries) {
          first ??= entry.timestampMs; last = entry.timestampMs;
          for (const poll of entry.votePolls) {
            count++;
            const p = poll.toJSON();
            if (p.contractId === CHARTERS && p.documentTypeName === 'electedCharter' && p.indexName === 'byTargetContract' && p.indexValues[0] === target) endsAtMs = Number(entry.timestampMs);
          }
        }
      } finally { for (const entry of entries) entry.free(); }
      if (endsAtMs !== null || count < 100 || last === undefined) break;
      lower = { startTimeMs: last, startTimeIncluded: first !== last };
    }
    // The poll end moves from join-close to final-close when a second contender enters.
    const joinClosesAtMs = endsAtMs === null ? null : endsAtMs - (contenders.length > 1 ? declaration.voteWindow * 1000 : 0);
    const phase = team ? 'seated' : state.winner ? 'decided' : contenders.length === 0 ? 'no election' : joinClosesAtMs === null || !Number.isFinite(chainMs) ? 'open (phase time unavailable)' : chainMs < joinClosesAtMs ? 'joining' : 'voting';
    return { contract: name, targetContractId: target, phase, declaration: { joinWindow: declaration.joinWindow, voteWindow: declaration.voteWindow, interim: declaration.interim.$type },
      proposals: [...proposals.values()].filter(Boolean).map((d) => ({ id: d.id.toBase58(), leaderId: d.ownerId.toBase58() })),
      contenders, abstain: state.abstainVoteTally ?? null, lock: state.lockVoteTally ?? null, joinClosesAtMs, endsAtMs,
      winner: state.winner ? { kind: state.winner.kind, identityId: state.winner.identityId?.toBase58() ?? null,
        block: { height: String(state.winner.block.height), timeMs: String(state.winner.block.timeMs) } } : null,
      team: team ? { electedCharterId: team.electedCharterId.toBase58(), submittedCharterId: team.submittedCharterId.toBase58(),
        leaderId: team.leaderId.toBase58(), members: team.members.map((id) => id.toBase58()) } : null, chain: chain.chain };
  } finally { state.free(); team?.free(); contract.free(); }
}

async function live(sdk, manifest, options) {
  const path = resolve(options.journal), dir = dirname(path);
  prepareDirectory(dir);
  const lock = `${path}.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(fd, json({ pid: process.pid }));
    const scope = { network: options.network, devnet: options.network === 'devnet' ? devnetName() : null, configHash: manifestHash(manifest), targetContractId: manifest.targetContractId };
    if (existsSync(path)) privateFile(path);
    const state = existsSync(path) ? readJson(path) : { ...scope, keys: {}, steps: {} };
    for (const [key, value] of Object.entries(scope)) if (state[key] !== value) throw new Error(`journal ${key} disagrees with this run; refusing to mix networks or charters`);
    const save = () => writeCheckpoint(path, state);
    save();
    // A completed journal is read-only on resume, even if the contest deposit
    // means the leader no longer meets the balance needed for a new application.
    const application = state.steps.application;
    const applicationProved = application && await (application.state === 'broadcasting'
      ? waitForStep(sdk, application, state.targetContractId) : existsStep(sdk, application, state.targetContractId));
    if (applicationProved) {
      state.steps.application.state = 'verified'; save();
      console.log(`Application ${state.steps.application.id} already proved; nothing to broadcast.`); return;
    }
    if (!options.prepare && !state.prepared) throw new Error('prepared journal required; run --live --prepare before registration');
    const balances = await balancesFor(sdk, manifest);
    console.log(json({ balances }));
    if (balances.some((b) => !b.ready && (b.role === 'leader' || state.steps[`join-${b.identityId}`]?.state !== 'verified'))) throw new Error('insufficient balance: leader needs at least 0.51 DASH; each member needs 0.001 DASH reserve');
    const actors = [];
    for (const actor of [manifest.leader, ...manifest.members]) actors.push(await actorFor(sdk, actor));
    const [leader, ...members] = actors;
    const charters = await sdk.contracts.fetch(CHARTERS);
    if (!charters) throw new Error('charters contract could not be proved');
    charters.free();
    await prepareBoundKey(sdk, leader, 'DECRYPTION', 'submittedCharter', state, dir, save, options.prepare);
    const encryptionKeys = [];
    for (const member of members) encryptionKeys.push(await prepareBoundKey(sdk, member, 'ENCRYPTION', 'joinRequest', state, dir, save, options.prepare));
    const reasons = [];
    for (const reason of manifest.reasons) {
      if (!options.prepare && state.steps[`reason-${reason.code}`]?.state !== 'verified') throw new Error(`reason ${reason.code} is not prepared`);
      const step = await commitStep(sdk, state, `reason-${reason.code}`, save, async () => {
        // Reason codes are unique per leader, across all three target contracts.
        const existing = await sdk.documents.query({ dataContractId: CHARTERS, documentTypeName: 'reason',
          where: [['$ownerId', '==', leader.identityId], ['code', '==', reason.code]], limit: 1 });
        const found = [...existing.values()].find(Boolean);
        if (found) {
          const data = found.toJSON();
          if (data.label !== reason.label || (data.description ?? null) !== (reason.description ?? null)) throw new Error(`reason ${reason.code} already exists with different text; choose another code`);
          return { id: found.id.toBase58(), type: 'reason', owner: leader.identityId, state: 'verified' };
        }
        return createStep(sdk, state, leader, 'reason', { code: reason.code, label: reason.label, ...(reason.description ? { description: reason.description } : {}) });
      });
      reasons.push(step.id);
    }
    const proposalData = { targetContractId: idBytes(manifest.targetContractId), description: manifest.description,
      reasons: reasons.map(idBytes), moderatorsShare: manifest.moderatorsShare, rewardSplit: manifest.rewardSplit };
    if (options.prepare) {
      const remaining = await sdk.identities.balance(leader.identityId);
      if (remaining === undefined || BigInt(remaining) < LEADER_MINIMUM) throw new Error('preparation left leader below 0.51 DASH; top up then resume preparation');
      state.prepared = true; save();
      console.log('Keys and reasons proved; charter payload prepared. Proposal will be signed with the current nonce at filing. Run --live at registration.'); return;
    }
    const target = await registered(sdk, manifest.targetContractId, options.waitSeconds, manifest.expected);
    const seated = await sdk.moderationCharters.team(manifest.targetContractId);
    if (seated) { seated.free(); throw new Error('target already has a seated team'); }
    state.registered = { targetContractId: manifest.targetContractId, ...manifest.expected }; target.free(); save();
    const proposal = await commitStep(sdk, state, 'proposal', save, () => createStep(sdk, state, leader, 'submittedCharter', proposalData));
    const joined = await Promise.allSettled(members.map(async (member, i) => {
      await commitStep(sdk, state, `join-${member.identityId}`, save, async () => {
        const writer = await sdk.identities.fetch(member.identityId);
        const join = await sdk.moderationCharters.buildJoinRequest({ submittedCharterId: proposal.id, message: member.message ?? 'I offer to serve on this moderation team.', writer, writerEncryptionKey: encryptionKeys[i] });
        // Keep the SDK's encryption envelope and recipient/sender key ids.
        const data = join.toObject();
        for (const key of Object.keys(data)) if (key.startsWith('$')) delete data[key];
        return createStep(sdk, state, member, 'joinRequest', data);
      });
    }));
    const failedJoin = joined.find((result) => result.status === 'rejected');
    if (failedJoin) throw failedJoin.reason;
    const snapshot = await watchContract(sdk, manifest.contract, manifest.targetContractId);
    if (snapshot.winner || snapshot.team || (snapshot.contenders.length && snapshot.phase !== 'joining')) throw new Error('target contest is decided or joining is closed/unknown; refusing application');
    // Check again immediately before committing the nonrefundable contest fund.
    const remaining = await sdk.identities.balance(leader.identityId);
    if (remaining === undefined || BigInt(remaining) < LEADER_MINIMUM) throw new Error('leader fell below 0.51 DASH before application; top up and resume the same journal');
    await commitStep(sdk, state, 'application', save, () => createStep(sdk, state, leader, 'electedCharter', { targetContractId: idBytes(manifest.targetContractId), submittedCharterId: idBytes(proposal.id), members: members.map((m) => idBytes(m.identityId)) }, true));
    console.log('Application proved. Tie-break priority starts at this elected application, not the submitted proposal. Watch for rivals and arrange masternode votes.');
  } finally { closeSync(fd); unlinkSync(lock); }
}

function safeError(error) {
  return String(error?.message ?? error).replace(/\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, '[redacted key]').replace(/\b[0-9a-f]{64}\b/gi, '[redacted hex]');
}

export async function main(argv = process.argv.slice(2)) {
  const options = charterOptions(argv);
  const manifest = options.config ? validateManifest(readJson(resolve(options.config))) : null;
  if (options.mode === 'plan') {
    console.log(json({ network: options.network, contract: manifest.contract, targetContractId: manifest.targetContractId,
      expected: manifest.expected, leader: manifest.leader.identityId, members: manifest.members.map((m) => m.identityId),
      leaderMinimum: `${formatCredits(LEADER_MINIMUM)} (0.51 DASH per application)`, contestFund: String(FUND),
      sequence: ['prepare leader DECRYPTION/submittedCharter key, member ENCRYPTION/joinRequest keys, and reasons before registration',
        'wait for proved matching registration; sign using current nonce', 'submit prepared charter', 'commit member joins', 'file elected application', 'watch, vote, and prove seated team'],
      broadcasts: false, keysRead: false })); return;
  }
  if (options.mode === 'live' && !options.prepare) {
    if (!existsSync(resolve(options.journal))) throw new Error('prepared journal required; run --live --prepare before registration');
    privateFile(resolve(options.journal));
    const journal = readJson(resolve(options.journal));
    if (!journal.prepared && !journal.steps?.application) throw new Error('prepared journal required; run --live --prepare before registration');
  }
  await w.ensureInitialized();
  const sdk = await connectSdk();
  // Ratchet to the proved protocol before constructing v14 documents.
  const epoch = await sdk.epoch.current();
  if (!Number.isInteger(Number(epoch.protocolVersion)) || Number(epoch.protocolVersion) < 14) throw new Error('charter filing requires proved protocol version 14 or later');
  if (options.mode === 'watch') {
    const targets = options.targets ? options.targets.split(',').map((pair) => pair.split('=')) : [[manifest.contract, manifest.targetContractId]];
    for (const [name, target] of targets) {
      if (!['social', 'blog', 'storefront'].includes(name) || !identityId(target)) throw new Error('invalid --targets entry');
      console.log(json(await watchContract(sdk, name, target)));
    }
  } else if (options.mode === 'dry-run') {
    const balances = await balancesFor(sdk, manifest);
    const contract = await sdk.contracts.fetch(manifest.targetContractId);
    let declarationMatches = false, declarationError = null;
    if (contract) { try { assertRegistered(contract, manifest.expected); declarationMatches = true; } catch (error) { declarationError = safeError(error); } }
    console.log(json({ network: options.network, contract: manifest.contract, targetContractId: manifest.targetContractId,
      declarationMatches, declarationError, registered: Boolean(contract), declaration: contract?.config.moderation?.moderators ?? null,
      balances, ready: balances.every((b) => b.ready) && declarationMatches, broadcasts: false, keysRead: false,
      note: 'Read-only preflight: placeholder identities may be absent. Signing keys and bound prerequisites are checked by --live --prepare.' }));
    contract?.free();
  } else await live(sdk, manifest, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(() => process.exit(0)).catch((error) => { console.error(`Charter filing stopped: ${safeError(error)}`); process.exit(1); });
}
