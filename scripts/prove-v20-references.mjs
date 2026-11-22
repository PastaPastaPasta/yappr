/**
 * Network proof of social v20's new checks (docs/SOCIAL_V20.md) on a testnet
 * or devnet registration, with identity key files instead of a seed ledger:
 *
 *   follow   d1e: a followRequest to an identity that does not exist is 40120 on
 *            targetId; one to --target lands
 *   report   r1z3a: an account report (about 1) of an identity that does not
 *            exist is 40120 on targetOwnerId; one of --target lands
 *   embed    c1e: a post embedding from a contract that does not exist is
 *            40120; c1f: one naming --embed-contract lands; a plain post of the
 *            same length lands
 *   thread   a post, a direct reply (no replyToReplyId) and a nested reply
 *   remove   the --moderator (CRITICAL key 1) removes both replies, citing
 *            --reason-doc; the records must keep exactly the type's
 *            deleteKeepsFields (replyToReplyId only on the nested one). The
 *            thread's author must be outside the team: a moderator's or the
 *            owner's document can not be moderated (41102)
 *
 * Every write records the author's proved balance before and after it, so the
 * state file holds each shape's fee. `--contract` may name a v19 copy to measure
 * the same follow/report/embed shapes without the reference read.
 *
 *   NETWORK=testnet node scripts/prove-v20-references.mjs <step> --contract ID --author KEYFILE \
 *     --state FILE [--target ID] [--embed-contract ID] [--moderator KEYFILE --reason-doc ID]
 *
 * Writes are journaled in --state and skipped on a re-run. Refuses NETWORK=mainnet.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import bs58 from 'bs58';
import { connectSdk, network } from './sdk-env.mjs';
import { describeErr, resolveKeyFileOwner, signerFor } from './owner-keys.mjs';
import { describeValue, feeAgreement, manualCreate, settle } from './social-battery-lib.mjs';
import { actionFeeOf, socialShapes } from './social-shapes.mjs';
import { fetchDocument, randomIdBytes, readback } from './verify-lib.mjs';

const REFERENCE_NOT_FOUND = /\bcode"?\s*[=:]\s*40120\b|referenced .{0,80}not found|referencedentitynotfound/i;
const AUTHOR_KEY_ID = 2;
const MODERATOR_KEY_ID = 1;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  contract: { type: 'string' }, author: { type: 'string' }, state: { type: 'string' }, target: { type: 'string' },
  'embed-contract': { type: 'string' }, moderator: { type: 'string' }, 'reason-doc': { type: 'string' },
} });
const [step] = positionals;
if (network() === 'mainnet') throw new Error('prove-v20-references writes; it never runs on mainnet');
if (!['follow', 'report', 'embed', 'thread', 'remove'].includes(step)) throw new Error('step: follow | report | embed | thread | remove');
if (!values.contract || !values.author || !values.state) throw new Error('--contract, --author and --state are required');

const state = existsSync(values.state) ? JSON.parse(readFileSync(values.state, 'utf8')) : {};
state[values.contract] ??= {};
const journal = state[values.contract];
const save = () => {
  writeFileSync(`${values.state}.tmp`, describeValue(state), { mode: 0o600 });
  renameSync(`${values.state}.tmp`, values.state);
};
let failures = 0;
const verdict = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const sdk = await connectSdk();
const contract = await readback(() => sdk.contracts.fetch(values.contract));
if (!contract) throw new Error(`contract ${values.contract} not found`);
const schemas = contract.toJSON().documentSchemas;
const SOCIAL = socialShapes(contract.toJSON());
const ctx = { sdk, contractId: values.contract };

async function actor(file, keyId) {
  const owner = resolveKeyFileOwner({ file, keyId });
  return { ...owner, ...(await signerFor(sdk, owner)) };
}
const author = await actor(values.author, AUTHOR_KEY_ID);

async function provedBalance(ownerId) {
  const response = await readback(() => sdk.identities.balanceWithProof(ownerId));
  return { credits: BigInt(response.data), height: Number(response.metadata.height) };
}

async function stableBalance(ownerId, floorHeight) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = await provedBalance(ownerId);
    await settle();
    const second = await provedBalance(ownerId);
    if (first.credits === second.credits && second.height > floorHeight) return second;
  }
  throw new Error(`the balance of ${ownerId} did not settle`);
}

/** One create, journaled under `key`, with the author's proved balance around it. */
async function measuredCreate(key, docType, data) {
  if (journal[key]) {
    console.log(`(journaled) ${key}: ${journal[key].ok ? `landed ${journal[key].id}` : 'refused'}`);
    return journal[key];
  }
  const fee = actionFeeOf(schemas, docType);
  const agreement = fee ? (await feeAgreement(ctx, fee)).agreement : undefined;
  const before = await stableBalance(author.ownerId, 0);
  const outcome = await manualCreate(ctx, author, { docType, data, agreement });
  const after = await stableBalance(author.ownerId, before.height);
  const entry = {
    key, docType, ok: outcome.ok, id: outcome.ok ? outcome.id : null, error: outcome.ok ? null : outcome.error,
    actionFeeModerators: fee ? String(fee.moderators) : '0',
    balanceBefore: String(before.credits), heightBefore: before.height,
    balanceAfter: String(after.credits), heightAfter: after.height, paid: String(before.credits - after.credits),
    at: new Date().toISOString(),
  };
  journal[key] = entry;
  save();
  console.log(`${key}: ${entry.ok ? `landed ${entry.id}` : 'refused'}; paid ${entry.paid} credits (heights ${entry.heightBefore}→${entry.heightAfter})`);
  return entry;
}

function expectRefused(label, entry, detail) {
  const error = entry.error ?? '';
  verdict(label, !entry.ok && REFERENCE_NOT_FOUND.test(error) && (!detail || detail.test(error)), entry.ok ? `landed ${entry.id}` : error.slice(0, 400));
}
const expectLanded = (label, entry) => verdict(label, entry.ok, entry.ok ? entry.id : (entry.error ?? '').slice(0, 400));
const requireFlag = (name) => {
  if (!values[name]) throw new Error(`${step} needs --${name}`);
  return values[name];
};

if (step === 'follow') {
  const target = requireFlag('target');
  expectRefused('d1e a followRequest to an identity that does not exist is refused 40120 on targetId',
    await measuredCreate('d1e', 'followRequest', { targetId: randomIdBytes() }), /targetId/);
  expectLanded(`a followRequest to ${target} lands`, await measuredCreate(`follow:${target}`, 'followRequest', { targetId: bs58.decode(target) }));
}

if (step === 'report') {
  const target = requireFlag('target');
  expectRefused('r1z3a an account report of an identity that does not exist is refused 40120 on targetOwnerId',
    await measuredCreate('r1z3a', 'report', SOCIAL.report({ about: 1, targetOwnerId: randomIdBytes(), reason: 1 })), /targetOwnerId/);
  expectLanded(`an account report of ${target} lands`,
    await measuredCreate(`report:${target}`, 'report', SOCIAL.report({ about: 1, targetOwnerId: bs58.decode(target), reason: 1 })));
}

if (step === 'embed') {
  const embedContract = requireFlag('embed-contract');
  const embed = (contractIdBytes) => SOCIAL.post({ content: 'v20 embed proof', embedContractId: contractIdBytes, embedDocType: 'poll', embedId: randomIdBytes() });
  expectRefused('c1e a post embedding from a contract that does not exist is refused 40120 on embedContractId',
    await measuredCreate('c1e', 'post', embed(randomIdBytes())), /embedContractId/);
  expectLanded(`c1f a post embedding from ${embedContract} lands`, await measuredCreate('c1f', 'post', embed(bs58.decode(embedContract))));
  expectLanded('a plain post lands (the embed fee baseline)', await measuredCreate('plain-post', 'post', SOCIAL.post({ content: 'v20 embed proof' })));
}

if (step === 'thread') {
  const post = await measuredCreate('thread-post', 'post', SOCIAL.post({ content: 'v20 recovery proof' }));
  expectLanded('the thread post lands', post);
  if (post.ok) {
    const rootPostId = bs58.decode(post.id);
    const direct = await measuredCreate('direct-reply', 'reply', SOCIAL.reply({ content: 'v20 recovery proof: direct reply', rootPostId, rootOwnerId: bs58.decode(author.ownerId) }));
    expectLanded('the direct reply lands', direct);
    if (direct.ok) {
      expectLanded('the nested reply lands', await measuredCreate('nested-reply', 'reply', SOCIAL.reply({
        content: 'v20 recovery proof: nested reply', rootPostId, replyToReplyId: bs58.decode(direct.id), parentOwnerId: bs58.decode(author.ownerId),
      })));
    }
  }
}

if (step === 'remove') {
  const moderator = await actor(requireFlag('moderator'), MODERATOR_KEY_ID);
  const reasonDocumentId = requireFlag('reason-doc');
  const identity = await readback(() => sdk.identities.fetch(moderator.ownerId));
  const keeps = schemas.reply.moderatorAbilities.deleteKeepsFields;
  const removalRecord = async (id) => {
    const snapshot = (await readback(() => sdk.contracts.documentRemovalsWithProof({ contractId: values.contract, documentTypeName: 'reply', documentIds: [id] }))).toJSON();
    return { record: snapshot.data.removals.find((item) => item.documentId === id) ?? null, height: Number(snapshot.metadata.height) };
  };
  for (const key of ['direct-reply', 'nested-reply']) {
    const reply = journal[key];
    if (!reply?.ok) throw new Error(`run thread first: no ${key} in the state file`);
    const removal = journal[`remove:${key}`] ??= {};
    const stored = await fetchDocument(sdk, values.contract, 'reply', reply.id);
    if (stored) removal.stored = stored.toJSON();
    if (stored && !(await removalRecord(reply.id)).record) {
      removal.error = null;
      removal.at = new Date().toISOString();
      try {
        await sdk.contracts.moderatorDeleteDocument({ identity, contractId: values.contract, documentTypeName: 'reply', documentId: reply.id,
          reason: { text: 'v20 recovery proof', reasonDocumentId }, signer: moderator.signer });
      } catch (e) { removal.error = describeErr(e); }
      save();
      await settle();
    }
    const proved = await removalRecord(reply.id);
    removal.record = proved.record;
    removal.recordHeight = proved.height;
    save();
    const kept = removal.record?.keptFields ?? {};
    const expected = keeps.filter((field) => key === 'nested-reply' || field !== 'replyToReplyId');
    verdict(`the moderator removes the ${key} ${reply.id}`, removal.record?.moderatorId === moderator.ownerId && removal.record?.reason?.reasonDocumentId === reasonDocumentId,
      removal.record ? `record at proof height ${removal.recordHeight}` : (removal.error ?? 'no removal record'));
    verdict(`the ${key} record keeps exactly ${expected.join(', ')}`, describeValue(Object.keys(kept).sort()) === describeValue([...expected].sort()), describeValue(kept));
    const original = removal.stored ?? {};
    verdict(`the ${key} record's kept values are the stored document's`, expected.every((field) => String(kept[field]) === String(original[field])), describeValue(original));
    verdict(`the ${key} is gone`, (await fetchDocument(sdk, values.contract, 'reply', reply.id)) === null);
  }
}

console.log(failures === 0 ? `${step}: all checks passed` : `${step}: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
