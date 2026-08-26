/**
 * Phase-0 verification battery for the pollr v2 contract design (and the Phase-3
 * cross-app acceptance check). Exercises, against a registered pollr v2 contract:
 *
 *   1. poll create (string question + enumerated options, multiChoice, endsAt)
 *   2. a multi-choice ballot as ONE batch state transition (N vote creates, one signature)
 *   3. a single-choice vote from a second identity
 *   4. duplicate-vote rejection via the unique [pollId, $ownerId, choice] index
 *   5. count-tree tallies: grand-total prefix count, grouped per-choice count
 *      (equality prefix + groupBy), per-choice equality counts
 *   6. pollVotesByTime pagination cross-check of the count-tree numbers
 *
 * Uses e2e bot identities 0 (poll author + single vote) and 1 (multi ballot).
 *
 * Run:  node scripts/verify-poll-interop.mjs --contract <pollrV2ContractId>
 */
import {
  BatchTransition,
  BatchedTransition,
  Document,
  DocumentCreateTransition,
  EvoSDK,
  PlatformVersion,
  PrivateKey,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';

const SDK_TIMEOUT_MS = 30000;
/** DIP-30: lower 40 bits of the identity contract nonce are the sequence number. */
const SEQUENCE_MASK = (1n << 40n) - 1n;

function parseArgs(argv) {
  const args = { contract: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('--contract <pollrV2ContractId> is required');
  return args;
}

let failures = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function canonicalDoc({ contractId, docType, ownerId, entropy, data }) {
  const idBytes = Document.generateId(docType, ownerId, contractId, entropy);
  const doc = Document.fromObject(
    {
      $formatVersion: '0',
      $id: idBytes,
      $ownerId: bs58.decode(ownerId),
      $dataContractId: bs58.decode(contractId),
      $type: docType,
      $revision: 1n,
      $entropy: entropy,
      ...data,
    },
    PlatformVersion.current()
  );
  return { doc, id: bs58.encode(idBytes) };
}

/**
 * Creates one or more documents of one type. Tries a single batch state
 * transition first; the protocol currently rejects batches with more than one
 * document transition ("Amount of document transitions must be less or equal
 * to 1"), in which case this falls back to sequential single-create transitions
 * and reports `mode: 'sequential'` so the cap's eventual lifting is visible.
 */
async function createDocuments(sdk, signerInfo, { contractId, docType, datas }) {
  try {
    return { ids: await createDocumentsBatch(sdk, signerInfo, { contractId, docType, datas }), mode: 'batch' };
  } catch (e) {
    if (datas.length === 1 || !describeErr(e).includes('less or equal to 1')) throw e;
    const ids = [];
    for (const data of datas) {
      ids.push(...await createDocumentsBatch(sdk, signerInfo, { contractId, docType, datas: [data] }));
    }
    return { ids, mode: 'sequential' };
  }
}

async function createDocumentsBatch(sdk, signerInfo, { contractId, docType, datas }) {
  const { ownerId, wif, identityKey } = signerInfo;
  const rawNonce = (await sdk.wasm.getIdentityContractNonce(ownerId, contractId)) ?? 0n;
  const nonce = (rawNonce & SEQUENCE_MASK) + 1n;

  const built = datas.map((data) =>
    canonicalDoc({ contractId, docType, ownerId, entropy: crypto.getRandomValues(new Uint8Array(32)), data })
  );
  const batched = built.map(({ doc }) => {
    const create = new DocumentCreateTransition({ document: doc, identityContractNonce: nonce });
    return new BatchedTransition(create.toDocumentTransition());
  });
  const batch = BatchTransition.fromBatchedTransitions(batched, ownerId, 0);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce(nonce);
  st.sign(PrivateKey.fromWIF(wif), identityKey);

  await sdk.stateTransitions.broadcastStateTransition(st);
  try {
    await sdk.stateTransitions.waitForResponse(st);
  } catch (e) {
    // The DAPI gateway 504 quirk: broadcast landed, the wait timed out. Confirm by read.
    console.log(`  (waitForResponse failed: ${describeErr(e).slice(0, 160)} — confirming by read)`);
    await new Promise((r) => setTimeout(r, 3000));
    const confirmed = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [['$id', 'in', built.map((b) => b.id)]],
      orderBy: [['$id', 'asc']],
    });
    const found = confirmed instanceof Map ? confirmed.size : Object.keys(confirmed ?? {}).length;
    if (found !== built.length) throw e;
  }
  return built.map((b) => b.id);
}

async function botSigner(sdk, index) {
  const ownerId = loadIdentityIds()[index];
  if (!ownerId) throw new Error(`No bot identity at index ${index} in E2E_IDENTITY_IDS`);
  const wif = criticalAuthKey(deriveIdentityKeys(index)).wif;
  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error(`Identity ${ownerId} not found`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  return { ownerId, wif, identityKey };
}

function countEntries(raw) {
  return raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw ?? {});
}

const args = parseArgs(process.argv.slice(2));
const contractId = args.contract;

try {
  const sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: SDK_TIMEOUT_MS } });
  await sdk.connect();
  const bot0 = await botSigner(sdk, 0);
  const bot1 = await botSigner(sdk, 1);
  console.log(`connected; contract=${contractId} bot0=${bot0.ownerId} bot1=${bot1.ownerId}`);

  // 1. Poll create (bot0)
  const { ids: [pollId] } = await createDocuments(sdk, bot0, {
    contractId,
    docType: 'poll',
    datas: [{
      question: 'Which count-tree feature matters most?',
      option0: 'O(1) tallies',
      option1: 'Grouped counts',
      option2: 'Prefix totals',
      multiChoice: true,
      endsAt: Date.now() + 7 * 24 * 3600 * 1000,
    }],
  });
  console.log(`poll created: ${pollId}`);

  const readBack = await sdk.documents.query({
    dataContractId: contractId, documentTypeName: 'poll', where: [['$id', '==', pollId]],
  });
  const pollDoc = countEntries(readBack)[0]?.[1];
  const pollObj = pollDoc?.toObject ? pollDoc.toObject() : pollDoc;
  check('poll round-trip', pollObj?.question === 'Which count-tree feature matters most?'
    && pollObj?.option2 === 'Prefix totals' && pollObj?.multiChoice === true,
    `question=${JSON.stringify(pollObj?.question)} multiChoice=${JSON.stringify(pollObj?.multiChoice)}`);

  const pollIdBytes = bs58.decode(pollId);
  const pollOwnerBytes = bs58.decode(bot0.ownerId);
  const voteData = (choice) => ({ pollId: pollIdBytes, pollOwnerId: pollOwnerBytes, choice });

  // 2. Multi-choice ballot from bot1 (choices 0 and 2) — batch if the protocol
  // allows it, sequential single-create transitions otherwise
  let multiMode = null;
  try {
    ({ mode: multiMode } = await createDocuments(sdk, bot1, {
      contractId, docType: 'vote', datas: [voteData(0), voteData(2)],
    }));
  } catch (e) {
    console.log(`  multi-ballot error: ${describeErr(e)}`);
  }
  check('multi-choice ballot lands (2 votes)', multiMode !== null, `mode=${multiMode}`);

  // 3. Single vote from bot0 (choice 1)
  await createDocuments(sdk, bot0, { contractId, docType: 'vote', datas: [voteData(1)] });
  check('single vote create', true);

  // 4. Duplicate vote (bot1, choice 0 again) must be rejected by the unique index
  let dupRejected = false;
  let dupDetail = 'accepted (BAD)';
  try {
    await createDocuments(sdk, bot1, { contractId, docType: 'vote', datas: [voteData(0)] });
  } catch (e) {
    dupRejected = true;
    dupDetail = describeErr(e).slice(0, 200);
  }
  check('duplicate vote rejected on-chain', dupRejected, dupDetail);

  // Give count trees a beat to settle behind the read quorum.
  await new Promise((r) => setTimeout(r, 3000));

  // 5a. Grand-total prefix count on the 2-property countable index
  const totalRaw = await sdk.documents.count({
    dataContractId: contractId, documentTypeName: 'vote', where: [['pollId', '==', pollId]],
  });
  console.log('  grand-total raw:', countEntries(totalRaw).map(([k, v]) => `${JSON.stringify(k)}=>${v}`).join(', '));
  const total = totalRaw instanceof Map ? totalRaw.get('') : totalRaw?.[''];
  check('prefix grand total == 3', Number(total) === 3, `got ${total}`);

  // 5b. Grouped per-choice count: equality prefix + choice-in + groupBy
  let groupedEntries = [];
  let groupedErr = null;
  try {
    const groupedRaw = await sdk.documents.count({
      dataContractId: contractId,
      documentTypeName: 'vote',
      where: [['pollId', '==', pollId], ['choice', 'in', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]],
      groupBy: ['choice'],
    });
    groupedEntries = countEntries(groupedRaw);
    console.log('  grouped raw entries:', groupedEntries.map(([k, v]) => `${JSON.stringify(k)}=>${v}`).join(', '));
  } catch (e) {
    groupedErr = describeErr(e);
    console.log(`  grouped count error: ${groupedErr}`);
  }
  check('grouped per-choice count returns 3 buckets of 1',
    groupedEntries.filter(([k]) => k !== '').length === 3
      && groupedEntries.filter(([k]) => k !== '').every(([, v]) => Number(v) === 1),
    groupedErr ?? `entries=${groupedEntries.length}`);

  // 5c. Per-choice equality counts (the guaranteed fallback path)
  const perChoice = [];
  for (const choice of [0, 1, 2, 3]) {
    const raw = await sdk.documents.count({
      dataContractId: contractId, documentTypeName: 'vote',
      where: [['pollId', '==', pollId], ['choice', '==', choice]],
    });
    const n = raw instanceof Map ? raw.get('') : raw?.[''];
    perChoice.push(Number(n ?? 0));
  }
  check('per-choice equality counts == [1,1,1,0]', JSON.stringify(perChoice) === '[1,1,1,0]', JSON.stringify(perChoice));

  // 6. pollVotesByTime pagination cross-check
  const votesRaw = await sdk.documents.query({
    dataContractId: contractId,
    documentTypeName: 'vote',
    where: [['pollId', '==', pollId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 100,
  });
  const votes = countEntries(votesRaw).map(([, d]) => (d?.toObject ? d.toObject() : d));
  const scanned = [0, 0, 0, 0];
  for (const vote of votes) scanned[Number(vote.choice)] += 1;
  check('pagination scan matches count trees', votes.length === 3 && JSON.stringify(scanned) === '[1,1,1,0]',
    `votes=${votes.length} scanned=${JSON.stringify(scanned)}`);

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
