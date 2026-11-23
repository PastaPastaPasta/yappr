/**
 * Network proof of social v20's new checks (docs/SOCIAL_V20.md) on a testnet
 * or devnet registration, with identity key files instead of a seed ledger.
 * One run, in order:
 *
 *   d1e    a followRequest to an identity that does not exist is 40120 on
 *          targetId; one to --target lands
 *   r1z3a  an account report (about 1) of an identity that does not exist is
 *          40120 on targetOwnerId; one of --target lands
 *   c1e    a post embedding from a contract that does not exist is 40120 on
 *          embedContractId; c1f: one naming --embed-contract lands; a plain
 *          post lands as the embed fee baseline
 *   thread a post, a direct reply and a nested reply
 *   remove the --moderator (CRITICAL key 1) removes both replies, citing
 *          --reason-doc; each removal record must keep exactly the type's
 *          deleteKeepsFields (replyToReplyId only on the nested one), with the
 *          stored document's values, and the reply must be gone
 *
 * The author (HIGH key 2) must be outside the moderation team: a moderator's
 * or the owner's document can't be moderated (41102). Every write records the
 * author's proved balance before and after it, so --out holds each shape's fee.
 *
 *   NETWORK=testnet node scripts/prove-v20-references.mjs --contract ID --author KEYFILE \
 *     --target ID --embed-contract ID --moderator KEYFILE --reason-doc ID --out FILE
 *
 * Nothing is resumed: --out is evidence only, written as the run goes and never
 * read back, and must not exist yet. A rerun writes fresh documents; it stops
 * before any write if the author already follows-requests or reports --target.
 * Refuses NETWORK=mainnet and any contract that is not social v20.
 */
import { renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import bs58 from 'bs58';
import { network } from './sdk-env.mjs';
import { describeErr, resolveKeyFileOwner, signerFor } from './owner-keys.mjs';
import { describeValue, feeAgreement, manualCreate, settle } from './social-battery-lib.mjs';
import { actionFeeOf, socialShapes } from './social-shapes.mjs';
import { NONCE_SEQUENCE_MASK } from './seed/seed-lib.mjs';
import { connectNetworkSdk, randomIdBytes, readback } from './verify-lib.mjs';
import { CHARTERS_CONTRACT_ID } from '../lib/moderation-charters/rules.mjs';

const REFERENCE_NOT_FOUND = /\bcode"?\s*[=:]\s*40120\b|referenced .{0,80}not found|referencedentitynotfound/i;
const AUTHOR_KEY_ID = 2;
const MODERATOR_KEY_ID = 1;
const REQUIRED = ['contract', 'author', 'target', 'embed-contract', 'moderator', 'reason-doc', 'out'];

const { values } = parseArgs({ options: Object.fromEntries(REQUIRED.map((name) => [name, { type: 'string' }])) });
if (network() === 'mainnet') throw new Error('prove-v20-references writes; it never runs on mainnet');
const missing = REQUIRED.filter((name) => !values[name]);
if (missing.length) throw new Error(`missing ${missing.map((name) => `--${name}`).join(', ')}`);

const evidence = { network: network(), contract: values.contract, startedAt: new Date().toISOString(), writes: [], removals: [], verdicts: [] };
try {
  writeFileSync(values.out, '', { flag: 'wx', mode: 0o600 });
} catch {
  throw new Error(`${values.out} exists or can't be created; evidence files are never overwritten`);
}
let checkpoint = 0;
const save = () => {
  const temporary = `${values.out}.${process.pid}.${checkpoint++}.tmp`;
  writeFileSync(temporary, describeValue(evidence), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, values.out);
};
const verdict = (label, ok, detail = '') => {
  evidence.verdicts.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const { sdk } = await connectNetworkSdk(values.contract);
const contract = await readback(() => sdk.contracts.fetch(values.contract));
if (!contract) throw new Error(`contract ${values.contract} not found`);
const schemas = contract.toJSON().documentSchemas;
const keeps = schemas.reply?.moderatorAbilities?.deleteKeepsFields ?? [];
if (!keeps.includes('replyToReplyId')) throw new Error(`${values.contract} is not social v20: its reply removals do not keep replyToReplyId`);
for (const [type, property, kind] of [['followRequest', 'targetId', 'identity'], ['report', 'targetOwnerId', 'identity'], ['post', 'embedContractId', 'contract']]) {
  if (schemas[type]?.properties?.[property]?.refersTo?.type !== kind) throw new Error(`${values.contract} is not social v20: ${type}.${property} does not declare refersTo ${kind}`);
}
const SOCIAL = socialShapes(contract.toJSON());
const ctx = { sdk, contractId: values.contract };

async function actor(file, keyId) {
  const owner = resolveKeyFileOwner({ file, keyId });
  return { ...owner, ...(await signerFor(sdk, owner)) };
}
const author = await actor(values.author, AUTHOR_KEY_ID);
const moderator = await actor(values.moderator, MODERATOR_KEY_ID);
const moderatorIdentity = await readback(() => sdk.identities.fetch(moderator.ownerId));
if (!moderatorIdentity) throw new Error(`--moderator ${moderator.ownerId} is not an identity`);
evidence.author = author.ownerId;
evidence.moderator = moderator.ownerId;

const team = await readback(() => sdk.moderationCharters.team(values.contract));
if (!team) throw new Error(`${values.contract} has no seated moderation team; the removals must come from a seated moderator`);
try {
  if (!team.contains(moderator.ownerId)) throw new Error(`--moderator ${moderator.ownerId} is not on ${values.contract}'s seated team`);
  if (team.contains(author.ownerId)) throw new Error(`--author ${author.ownerId} is on the seated team; team content can't be moderated, pick a non-member`);
  evidence.seatedCharter = { elected: team.electedCharterId.toBase58(), submitted: team.submittedCharterId.toBase58() };
} finally {
  team.free();
}
await readback(() => sdk.contracts.fetch(CHARTERS_CONTRACT_ID));
const charter = await readback(() => sdk.documents.get(CHARTERS_CONTRACT_ID, 'submittedCharter', evidence.seatedCharter.submitted));
const charterReasons = (charter?.toJSON().reasons ?? []).map(String);
if (!charterReasons.includes(values['reason-doc'])) {
  throw new Error(`--reason-doc ${values['reason-doc']} is not a reason of the seated charter ${evidence.seatedCharter.submitted}`);
}

const query = (documentTypeName, where) => readback(async () => (await sdk.documents.query({ dataContractId: values.contract, documentTypeName, where, limit: 1 })).size);
if (values.target === author.ownerId) throw new Error('--target must differ from --author; pick another identity');
const targetBytes = bs58.decode(values.target);
if (!(await readback(() => sdk.identities.fetch(values.target)))) throw new Error(`--target ${values.target} is not an identity`);
if (!(await readback(() => sdk.contracts.fetch(values['embed-contract'])))) throw new Error(`--embed-contract ${values['embed-contract']} not found`);
if (await query('followRequest', [['targetId', '==', values.target], ['$ownerId', '==', author.ownerId]])) {
  throw new Error(`${author.ownerId} already has a followRequest to ${values.target}; pick another --target`);
}
if (await query('report', [['targetOwnerId', '==', values.target], ['about', '==', 1], ['$ownerId', '==', author.ownerId]])) {
  throw new Error(`${author.ownerId} already reported ${values.target}; pick another --target`);
}
save();

async function provedBalance(ownerId) {
  const response = await readback(() => sdk.identities.balanceWithProof(ownerId));
  return { credits: BigInt(response.data), height: Number(response.metadata.height) };
}

/** Two equal proved balances at or above `floorHeight`; with `changedFrom`, they must differ from it (every write in this run pays). */
async function stableBalance(floorHeight, changedFrom) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = await provedBalance(author.ownerId);
    await settle();
    const second = await provedBalance(author.ownerId);
    if (first.credits === second.credits && second.height >= floorHeight && second.credits !== changedFrom) return second;
  }
  throw new Error(`the balance of ${author.ownerId} did not settle`);
}

async function provedNonce() {
  const response = await readback(() => sdk.identities.contractNonceWithProof(author.ownerId, values.contract));
  return { nonce: BigInt(response.data ?? 0n) & NONCE_SEQUENCE_MASK, height: Number(response.metadata.height) };
}
const contractNonce = async () => (await provedNonce()).nonce;

/** The author's contract nonce proved at or above `floorHeight` once it has moved past `from`. */
async function nextNonce(from, floorHeight) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { nonce, height } = await provedNonce();
    if (nonce > from && height >= floorHeight) return { nonce, height };
    await settle();
  }
  throw new Error(`the contract nonce of ${author.ownerId} did not move past ${from} at or above height ${floorHeight}`);
}

let lastHeight = 0;
/** One create with the author's proved balance around it. `refusedOn` makes a 40120 citing that property the expected outcome. */
async function measuredCreate(key, docType, data, refusedOn) {
  const fee = actionFeeOf(schemas, docType);
  const agreement = fee ? (await feeAgreement(ctx, fee)).agreement : undefined;
  const nonceBefore = await contractNonce();
  const before = await stableBalance(lastHeight);
  const outcome = await manualCreate(ctx, author, { docType, data, agreement });
  if (outcome.nonce !== nonceBefore + 1n) {
    throw new Error(`${key}: signed nonce ${outcome.nonce}, expected ${nonceBefore + 1n}; another writer used this author, so the fee can't be attributed`);
  }
  const refused = !outcome.ok && REFERENCE_NOT_FOUND.test(String(outcome.error)) && refusedOn?.test(String(outcome.error));
  const entry = { key, docType, ok: outcome.ok, id: outcome.ok ? outcome.id : null, error: outcome.ok ? null : outcome.error, actionFeeModerators: fee ? String(fee.moderators) : '0' };
  evidence.writes.push(entry);
  save();
  if (!outcome.ok && !refused) {
    throw new Error(`${key}: neither landed nor refused as expected; check ${author.ownerId}'s ${docType} documents before rerunning: ${String(outcome.error).slice(0, 300)}`);
  }
  const { nonce: nonceAfter, height: nonceHeight } = await nextNonce(nonceBefore, before.height + 1);
  if (nonceAfter !== outcome.nonce) {
    throw new Error(`${key}: ${author.ownerId}'s contract nonce moved ${nonceBefore} → ${nonceAfter} around the write signed at ${outcome.nonce}; another writer used this author, so the fee can't be attributed`);
  }
  const after = await stableBalance(nonceHeight, before.credits);
  const { nonce: nonceAtBalance } = await nextNonce(nonceBefore, after.height);
  if (nonceAtBalance !== outcome.nonce) {
    throw new Error(`${key}: ${author.ownerId}'s contract nonce moved to ${nonceAtBalance} by the post-write balance at height ${after.height}; another writer used this author, so the fee can't be attributed`);
  }
  lastHeight = after.height;
  Object.assign(entry, {
    balanceBefore: String(before.credits), heightBefore: before.height,
    balanceAfter: String(after.credits), heightAfter: after.height, paid: String(before.credits - after.credits),
  });
  save();
  console.log(`${key}: ${entry.ok ? `landed ${entry.id}` : 'refused'}; paid ${entry.paid} credits (heights ${before.height}→${after.height})`);
  return entry;
}

function expectRefused(label, entry, property) {
  verdict(label, !entry.ok && property.test(entry.error ?? ''), entry.ok ? `landed ${entry.id}` : (entry.error ?? '').slice(0, 400));
}
const expectLanded = (label, entry) => verdict(label, entry.ok, entry.ok ? entry.id : (entry.error ?? '').slice(0, 400));

expectRefused('d1e a followRequest to an identity that does not exist is refused 40120 on targetId',
  await measuredCreate('d1e', 'followRequest', { targetId: randomIdBytes() }, /targetId/), /targetId/);
expectLanded(`a followRequest to ${values.target} lands`, await measuredCreate('follow', 'followRequest', { targetId: targetBytes }));

expectRefused('r1z3a an account report of an identity that does not exist is refused 40120 on targetOwnerId',
  await measuredCreate('r1z3a', 'report', SOCIAL.report({ about: 1, targetOwnerId: randomIdBytes(), reason: 1 }), /targetOwnerId/), /targetOwnerId/);
expectLanded(`an account report of ${values.target} lands`,
  await measuredCreate('report', 'report', SOCIAL.report({ about: 1, targetOwnerId: targetBytes, reason: 1 })));

const embed = (contractIdBytes) => SOCIAL.post({ content: 'v20 embed proof', embedContractId: contractIdBytes, embedDocType: 'poll', embedId: randomIdBytes() });
expectRefused('c1e a post embedding from a contract that does not exist is refused 40120 on embedContractId',
  await measuredCreate('c1e', 'post', embed(randomIdBytes()), /embedContractId/), /embedContractId/);
expectLanded(`c1f a post embedding from ${values['embed-contract']} lands`, await measuredCreate('c1f', 'post', embed(bs58.decode(values['embed-contract']))));
expectLanded('a plain post lands (the embed fee baseline)', await measuredCreate('plain-post', 'post', SOCIAL.post({ content: 'v20 embed proof' })));

const post = await measuredCreate('thread-post', 'post', SOCIAL.post({ content: 'v20 recovery proof' }));
const rootPostId = bs58.decode(post.id);
const direct = await measuredCreate('direct-reply', 'reply', SOCIAL.reply({ content: 'v20 recovery proof: direct reply', rootPostId, rootOwnerId: bs58.decode(author.ownerId) }));
const nested = await measuredCreate('nested-reply', 'reply', SOCIAL.reply({
  content: 'v20 recovery proof: nested reply', rootPostId, replyToReplyId: bs58.decode(direct.id), parentOwnerId: bs58.decode(author.ownerId),
}));

const fetchReply = (id) => readback(async () => (await sdk.documents.get(values.contract, 'reply', id)) ?? null);
/** The reply as proved at or above `floorHeight` (null when absent). */
async function fetchReplyFrom(id, floorHeight) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await readback(() => sdk.documents.getWithProof(values.contract, 'reply', id));
    if (Number(response.metadata.height) >= floorHeight) return response.data ?? null;
    await settle();
  }
  throw new Error(`no proof of reply ${id} at or above height ${floorHeight}`);
}
async function removalRecord(id) {
  const snapshot = (await readback(() => sdk.contracts.documentRemovalsWithProof({ contractId: values.contract, documentTypeName: 'reply', documentIds: [id] }))).toJSON();
  return { record: snapshot.data.removals.find((item) => item.documentId === id) ?? null, height: Number(snapshot.metadata.height) };
}

for (const [key, reply] of [['direct-reply', direct], ['nested-reply', nested]]) {
  const stored = (await fetchReply(reply.id))?.toJSON();
  if (!stored) throw new Error(`${key} ${reply.id} is not readable before its removal`);
  const removal = { key, id: reply.id, stored, error: null };
  evidence.removals.push(removal);
  save();
  try {
    await sdk.contracts.moderatorDeleteDocument({ identity: moderatorIdentity, contractId: values.contract, documentTypeName: 'reply', documentId: reply.id,
      reason: { text: 'v20 recovery proof', reasonDocumentId: values['reason-doc'] }, signer: moderator.signer });
  } catch (e) {
    removal.error = describeErr(e);
  }
  let proved = { record: null, height: 0 };
  for (let attempt = 0; attempt < 5 && !proved.record; attempt++) {
    await settle();
    proved = await removalRecord(reply.id);
  }
  Object.assign(removal, { record: proved.record, recordHeight: proved.height });
  save();
  const kept = proved.record?.keptFields ?? {};
  const expected = keeps.filter((field) => key === 'nested-reply' || field !== 'replyToReplyId');
  if (key === 'nested-reply') verdict('the stored nested reply names its parent', stored.replyToReplyId === direct.id, String(stored.replyToReplyId));
  verdict(`the moderator removes the ${key} ${reply.id}`, proved.record?.moderatorId === moderator.ownerId && proved.record?.reason?.reasonDocumentId === values['reason-doc'],
    proved.record ? `record at proof height ${proved.height}` : (removal.error ?? 'no removal record'));
  verdict(`the ${key} record keeps exactly ${expected.join(', ')}`, describeValue(Object.keys(kept).sort()) === describeValue([...expected].sort()), describeValue(kept));
  verdict(`the ${key} record's kept values are the stored document's`, expected.every((field) => String(kept[field]) === String(stored[field])), describeValue(stored));
  verdict(`the ${key} is gone`, (await fetchReplyFrom(reply.id, proved.height)) === null);
}

const failures = evidence.verdicts.filter((item) => !item.ok).length;
evidence.finishedAt = new Date().toISOString();
save();
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
