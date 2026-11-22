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
 * state file holds each shape's fee. `--contract` must be a v20 social contract
 * (its reply removals keep replyToReplyId).
 *
 *   NETWORK=testnet node scripts/prove-v20-references.mjs <step> --contract ID --author KEYFILE \
 *     --state FILE [--target ID] [--embed-contract ID] [--moderator KEYFILE --reason-doc ID]
 *
 * Results are journaled in --state per network, contract and author, and skipped
 * on a re-run. An attempt is journaled before it is broadcast; if a run ends
 * without a landed write or the expected refusal, the next run stops on it until
 * someone checks the author's documents and deletes that entry. Refuses
 * NETWORK=mainnet.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import bs58 from 'bs58';
import { connectSdk, network } from './sdk-env.mjs';
import { describeErr, resolveKeyFileOwner, signerFor } from './owner-keys.mjs';
import { describeValue, feeAgreement, manualCreate, settle } from './social-battery-lib.mjs';
import { actionFeeOf, socialShapes } from './social-shapes.mjs';
import { randomIdBytes } from './verify-lib.mjs';

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
const save = () => {
  writeFileSync(`${values.state}.tmp`, describeValue(state), { mode: 0o600 });
  renameSync(`${values.state}.tmp`, values.state);
};
let failures = 0;
const verdict = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// verify-lib's readback rebuilds its own devnet battery SDK on a transport
// collapse, so this harness reads through a handle it reconnects itself.
const TRANSPORT_COLLAPSE = /^(?![\s\S]*quorum source unavailable)[\s\S]*(?:no available addresses|invalid quorum|quorum not found)/i;
let activeSdk = await connectSdk();
const sdk = new Proxy({}, {
  get(_, prop) {
    const value = activeSdk[prop];
    return typeof value === 'function' ? value.bind(activeSdk) : value;
  },
});
async function read(fn) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (TRANSPORT_COLLAPSE.test(describeErr(e))) {
        try {
          activeSdk = await connectSdk();
          await activeSdk.contracts.fetch(values.contract);
          continue;
        } catch (reconnectError) {
          lastError = reconnectError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`read failed after 6 attempts: ${describeErr(lastError)}`);
}

const contract = await read(() => sdk.contracts.fetch(values.contract));
if (!contract) throw new Error(`contract ${values.contract} not found`);
const schemas = contract.toJSON().documentSchemas;
if (!schemas.reply?.moderatorAbilities?.deleteKeepsFields?.includes('replyToReplyId')) {
  throw new Error(`${values.contract} is not social v20: its reply removals do not keep replyToReplyId`);
}
const SOCIAL = socialShapes(contract.toJSON());
const ctx = { sdk, contractId: values.contract };

async function actor(file, keyId) {
  const owner = resolveKeyFileOwner({ file, keyId });
  return { ...owner, ...(await signerFor(sdk, owner)) };
}
const author = await actor(values.author, AUTHOR_KEY_ID);
const scope = `${network()}:${values.contract}:${author.ownerId}`;
state[scope] ??= {};
const journal = state[scope];

async function provedBalance(ownerId) {
  const response = await read(() => sdk.identities.balanceWithProof(ownerId));
  return { credits: BigInt(response.data), height: Number(response.metadata.height) };
}

const fetchReply = (id) => read(async () => (await sdk.documents.get(values.contract, 'reply', id)) ?? null);

/** Two equal proved balances above `floorHeight`; with `changedFrom`, they must differ from it (a landed write always pays). */
async function stableBalance(ownerId, floorHeight, changedFrom) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = await provedBalance(ownerId);
    await settle();
    const second = await provedBalance(ownerId);
    if (first.credits === second.credits && second.height > floorHeight && second.credits !== changedFrom) return second;
  }
  throw new Error(`the balance of ${ownerId} did not settle`);
}

/**
 * One create, journaled under `key`, with the author's proved balance around it.
 * `refusedOn` names the property a 40120 refusal must cite for the case to count as refused.
 */
async function measuredCreate(key, docType, data, refusedOn) {
  if (journal[key]?.pending) {
    throw new Error(`${key}: an earlier attempt (${journal[key].at}) ended without a landed write or the expected refusal; ` +
      `check ${author.ownerId}'s ${docType} documents on ${values.contract}, then delete "${key}" under "${scope}" in ${values.state}`);
  }
  if (journal[key]) {
    console.log(`(journaled) ${key}: ${journal[key].ok ? `landed ${journal[key].id}` : 'refused'}`);
    return journal[key];
  }
  const fee = actionFeeOf(schemas, docType);
  const agreement = fee ? (await feeAgreement(ctx, fee)).agreement : undefined;
  const before = await stableBalance(author.ownerId, 0);
  journal[key] = { key, docType, pending: true, balanceBefore: String(before.credits), heightBefore: before.height, at: new Date().toISOString() };
  save();
  const outcome = await manualCreate(ctx, author, { docType, data, agreement });
  const after = await stableBalance(author.ownerId, before.height, outcome.ok ? before.credits : undefined);
  const entry = {
    key, docType, ok: outcome.ok, id: outcome.ok ? outcome.id : null, error: outcome.ok ? null : outcome.error,
    actionFeeModerators: fee ? String(fee.moderators) : '0',
    balanceBefore: String(before.credits), heightBefore: before.height,
    balanceAfter: String(after.credits), heightAfter: after.height, paid: String(before.credits - after.credits),
    at: new Date().toISOString(),
  };
  const settled = entry.ok || (refusedOn && REFERENCE_NOT_FOUND.test(String(entry.error)) && refusedOn.test(String(entry.error)));
  if (settled) {
    journal[key] = entry;
    save();
  }
  console.log(`${key}: ${entry.ok ? `landed ${entry.id}` : settled ? 'refused' : `failed (left pending): ${String(entry.error).slice(0, 300)}`}; paid ${entry.paid} credits (heights ${entry.heightBefore}→${entry.heightAfter})`);
  return entry;
}

function expectRefused(label, entry, detail) {
  const error = entry.error ?? '';
  verdict(label, !entry.ok && REFERENCE_NOT_FOUND.test(error) && detail.test(error), entry.ok ? `landed ${entry.id}` : error.slice(0, 400));
}
const expectLanded = (label, entry) => verdict(label, entry.ok, entry.ok ? entry.id : (entry.error ?? '').slice(0, 400));
const requireFlag = (name) => {
  if (!values[name]) throw new Error(`${step} needs --${name}`);
  return values[name];
};

if (step === 'follow') {
  const target = requireFlag('target');
  expectRefused('d1e a followRequest to an identity that does not exist is refused 40120 on targetId',
    await measuredCreate('d1e', 'followRequest', { targetId: randomIdBytes() }, /targetId/), /targetId/);
  expectLanded(`a followRequest to ${target} lands`, await measuredCreate(`follow:${target}`, 'followRequest', { targetId: bs58.decode(target) }));
}

if (step === 'report') {
  const target = requireFlag('target');
  expectRefused('r1z3a an account report of an identity that does not exist is refused 40120 on targetOwnerId',
    await measuredCreate('r1z3a', 'report', SOCIAL.report({ about: 1, targetOwnerId: randomIdBytes(), reason: 1 }), /targetOwnerId/), /targetOwnerId/);
  expectLanded(`an account report of ${target} lands`,
    await measuredCreate(`report:${target}`, 'report', SOCIAL.report({ about: 1, targetOwnerId: bs58.decode(target), reason: 1 })));
}

if (step === 'embed') {
  const embedContract = requireFlag('embed-contract');
  const embed = (contractIdBytes) => SOCIAL.post({ content: 'v20 embed proof', embedContractId: contractIdBytes, embedDocType: 'poll', embedId: randomIdBytes() });
  expectRefused('c1e a post embedding from a contract that does not exist is refused 40120 on embedContractId',
    await measuredCreate('c1e', 'post', embed(randomIdBytes()), /embedContractId/), /embedContractId/);
  expectLanded(`c1f a post embedding from ${embedContract} lands`, await measuredCreate(`c1f:${embedContract}`, 'post', embed(bs58.decode(embedContract))));
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
  const identity = await read(() => sdk.identities.fetch(moderator.ownerId));
  const keeps = schemas.reply.moderatorAbilities.deleteKeepsFields;
  const removalRecord = async (id) => {
    const snapshot = (await read(() => sdk.contracts.documentRemovalsWithProof({ contractId: values.contract, documentTypeName: 'reply', documentIds: [id] }))).toJSON();
    return { record: snapshot.data.removals.find((item) => item.documentId === id) ?? null, height: Number(snapshot.metadata.height) };
  };
  for (const key of ['direct-reply', 'nested-reply']) {
    const reply = journal[key];
    if (!reply?.ok) throw new Error(`run thread first: no ${key} in the state file`);
    const removal = journal[`remove:${key}`] ??= {};
    const stored = await fetchReply(reply.id);
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
    if (key === 'nested-reply' && removal.stored && !removal.stored.replyToReplyId) verdict('the stored nested reply names its parent', false);
    verdict(`the moderator removes the ${key} ${reply.id}`, removal.record?.moderatorId === moderator.ownerId && removal.record?.reason?.reasonDocumentId === reasonDocumentId,
      removal.record ? `record at proof height ${removal.recordHeight}` : (removal.error ?? 'no removal record'));
    verdict(`the ${key} record keeps exactly ${expected.join(', ')}`, describeValue(Object.keys(kept).sort()) === describeValue([...expected].sort()), describeValue(kept));
    const original = removal.stored ?? {};
    verdict(`the ${key} record's kept values are the stored document's`, expected.every((field) => String(kept[field]) === String(original[field])), describeValue(original));
    verdict(`the ${key} is gone`, (await fetchReply(reply.id)) === null);
  }
}

console.log(failures === 0 ? `${step}: all checks passed` : `${step}: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
