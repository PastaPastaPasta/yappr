/**
 * Phase-0 verification battery for the pollr v3 contract design (and the Phase-3
 * cross-app acceptance check). Exercises, against a registered pollr v3 contract:
 *
 *   1. poll create (string question + enumerated options, multiChoice, endsAt)
 *   2. a multi-choice ballot as ONE batch state transition (N multiVote creates)
 *   3. multiVote uniqueness: a repeat of the same choice is rejected, a distinct
 *      one is accepted
 *   4. SINGLE-CHOICE ENFORCEMENT: on the `vote` doctype, a voter's second choice
 *      is rejected by Platform, while a different voter's is accepted
 *   5. doctype isolation: a multiVote document written against a single-choice
 *      poll cannot move that poll's tally
 *   6. count-tree tallies: grouped per-choice count (equality prefix + groupBy),
 *      per-choice equality counts, and that the v2 `pollTotal` index is gone
 *   7. pollVotesByTime pagination cross-check of the count-tree numbers
 *
 * Uses e2e bot identities 0 (poll author) and 1 (second voter).
 *
 * Run:  node scripts/verify-poll-interop.mjs --contract <pollrV3ContractId>
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
  if (!args.contract) throw new Error('--contract <pollrV3ContractId> is required');
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

const ALL_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Grouped count keys are the hex of Platform's tagged integer byte: 0x80 + choice. */
const CHOICE_KEY_OFFSET = 0x80;

/** Assert Platform refuses a write. The rejection text is echoed for the log. */
async function expectRejected(label, run) {
  try {
    await run();
    check(label, false, 'accepted (BAD)');
  } catch (e) {
    check(label, true, describeErr(e).slice(0, 160));
  }
}

/** Per-choice counts off a doctype's `choiceCounts` count tree, in one grouped count. */
async function groupedCounts(sdk, docType, pollId) {
  const raw = await sdk.documents.count({
    dataContractId: contractId,
    documentTypeName: docType,
    where: [['pollId', '==', pollId], ['choice', 'in', ALL_CHOICES]],
    groupBy: ['choice'],
  });
  const counts = new Array(10).fill(0);
  for (const [key, value] of countEntries(raw)) {
    if (key === '') continue;
    counts[parseInt(key, 16) - CHOICE_KEY_OFFSET] = Number(value);
  }
  return counts;
}

/** The guaranteed fallback path: one equality count per choice. */
async function equalityCounts(sdk, docType, pollId, upTo) {
  const counts = [];
  for (let choice = 0; choice < upTo; choice++) {
    const raw = await sdk.documents.count({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [['pollId', '==', pollId], ['choice', '==', choice]],
    });
    const n = raw instanceof Map ? raw.get('') : raw?.[''];
    counts.push(Number(n ?? 0));
  }
  return counts;
}

/** Count trees settle behind the read quorum; give them a beat after a write. */
const settle = () => new Promise((r) => setTimeout(r, 3000));

try {
  const sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: SDK_TIMEOUT_MS } });
  await sdk.connect();
  const bot0 = await botSigner(sdk, 0);
  const bot1 = await botSigner(sdk, 1);
  console.log(`connected; contract=${contractId} bot0=${bot0.ownerId} bot1=${bot1.ownerId}`);

  const endsAt = Date.now() + 7 * 24 * 3600 * 1000;
  const ownerBytes = bs58.decode(bot0.ownerId);
  const ballot = (pollId, choice) => ({
    pollId: bs58.decode(pollId),
    pollOwnerId: ownerBytes,
    choice,
  });

  // ===================== multi-choice poll → `multiVote` =====================
  console.log('');
  console.log('--- multi-choice poll (multiVote) ---');

  const { ids: [multiPollId] } = await createDocuments(sdk, bot0, {
    contractId,
    docType: 'poll',
    datas: [{
      question: 'Which count-tree feature matters most?',
      option0: 'O(1) tallies',
      option1: 'Grouped counts',
      option2: 'Prefix totals',
      multiChoice: true,
      endsAt,
    }],
  });
  console.log(`multi poll created: ${multiPollId}`);

  const multiReadBack = await sdk.documents.query({
    dataContractId: contractId, documentTypeName: 'poll', where: [['$id', '==', multiPollId]],
  });
  const multiDoc = countEntries(multiReadBack)[0]?.[1];
  const multiObj = multiDoc?.toObject ? multiDoc.toObject() : multiDoc;
  check('multi poll round-trip', multiObj?.question === 'Which count-tree feature matters most?'
    && multiObj?.option2 === 'Prefix totals' && multiObj?.multiChoice === true,
    `question=${JSON.stringify(multiObj?.question)} multiChoice=${JSON.stringify(multiObj?.multiChoice)}`);

  // bot1 casts a two-choice ballot; bot0 casts one.
  let multiMode = null;
  try {
    ({ mode: multiMode } = await createDocuments(sdk, bot1, {
      contractId, docType: 'multiVote', datas: [ballot(multiPollId, 0), ballot(multiPollId, 2)],
    }));
  } catch (e) {
    console.log(`  multi-ballot error: ${describeErr(e)}`);
  }
  check('multi-choice ballot lands (2 selections)', multiMode !== null, `mode=${multiMode}`);

  await createDocuments(sdk, bot0, { contractId, docType: 'multiVote', datas: [ballot(multiPollId, 1)] });
  check('second voter records a selection', true);

  await expectRejected('multiVote: repeat of the same choice rejected', () =>
    createDocuments(sdk, bot1, { contractId, docType: 'multiVote', datas: [ballot(multiPollId, 0)] }));

  // The point of multi-choice: a *different* choice from the same voter is fine.
  await createDocuments(sdk, bot1, { contractId, docType: 'multiVote', datas: [ballot(multiPollId, 1)] });
  check('multiVote: a distinct additional choice is accepted', true);

  await settle();

  const multiGrouped = await groupedCounts(sdk, 'multiVote', multiPollId);
  check('multiVote grouped counts == [1,2,1]',
    JSON.stringify(multiGrouped.slice(0, 3)) === '[1,2,1]', JSON.stringify(multiGrouped.slice(0, 3)));

  const multiEquality = await equalityCounts(sdk, 'multiVote', multiPollId, 4);
  check('multiVote per-choice equality counts == [1,2,1,0]',
    JSON.stringify(multiEquality) === '[1,2,1,0]', JSON.stringify(multiEquality));

  // v3 drops v2's `pollTotal` index: it only ever fed a misleading
  // "zero counts + grand total" fallback, and the sum of choiceCounts is the
  // same number. A bare pollId count must therefore no longer resolve.
  await expectRejected('pollTotal index is gone (bare pollId count unavailable)', () =>
    sdk.documents.count({
      dataContractId: contractId, documentTypeName: 'multiVote', where: [['pollId', '==', multiPollId]],
    }));

  const multiScanRaw = await sdk.documents.query({
    dataContractId: contractId,
    documentTypeName: 'multiVote',
    where: [['pollId', '==', multiPollId]],
    orderBy: [['$createdAt', 'asc']],
    limit: 100,
  });
  const multiVotes = countEntries(multiScanRaw).map(([, d]) => (d?.toObject ? d.toObject() : d));
  const multiScanned = [0, 0, 0, 0];
  for (const vote of multiVotes) multiScanned[Number(vote.choice)] += 1;
  check('multiVote pagination scan matches count trees',
    multiVotes.length === 4 && JSON.stringify(multiScanned) === '[1,2,1,0]',
    `votes=${multiVotes.length} scanned=${JSON.stringify(multiScanned)}`);

  // ================== single-choice poll → `vote` (enforced) ==================
  console.log('');
  console.log('--- single-choice poll (vote) ---');

  const { ids: [singlePollId] } = await createDocuments(sdk, bot0, {
    contractId,
    docType: 'poll',
    // multiChoice omitted entirely — absent means single choice.
    datas: [{ question: 'Ship it?', option0: 'Yes', option1: 'No', endsAt }],
  });
  console.log(`single poll created: ${singlePollId}`);

  const singleReadBack = await sdk.documents.query({
    dataContractId: contractId, documentTypeName: 'poll', where: [['$id', '==', singlePollId]],
  });
  const singleDoc = countEntries(singleReadBack)[0]?.[1];
  const singleObj = singleDoc?.toObject ? singleDoc.toObject() : singleDoc;
  check('single poll round-trip (multiChoice absent)',
    singleObj?.question === 'Ship it?' && !singleObj?.multiChoice,
    `multiChoice=${JSON.stringify(singleObj?.multiChoice)}`);

  await createDocuments(sdk, bot0, { contractId, docType: 'vote', datas: [ballot(singlePollId, 0)] });
  check('single-choice ballot lands', true);

  // THE FINDING: under v2 this second, different choice was accepted and counted.
  // The voterBallot index is (pollId, $ownerId) with no choice, so Platform now
  // refuses it — single-choice is enforced on the wire, not by client convention.
  await expectRejected("vote: same voter's SECOND, DIFFERENT choice is rejected", () =>
    createDocuments(sdk, bot0, { contractId, docType: 'vote', datas: [ballot(singlePollId, 1)] }));

  // A different identity is of course unaffected.
  await createDocuments(sdk, bot1, { contractId, docType: 'vote', datas: [ballot(singlePollId, 1)] });
  check('vote: a different voter is unaffected', true);

  await settle();

  const singleGrouped = await groupedCounts(sdk, 'vote', singlePollId);
  check('vote grouped counts == [1,1]',
    JSON.stringify(singleGrouped.slice(0, 2)) === '[1,1]', JSON.stringify(singleGrouped.slice(0, 2)));

  // Doctype isolation. Nothing stops a hand-rolled client writing multiVote
  // documents against a single-choice poll — but the tally only ever reads the
  // doctype the poll's mode selects, so they cannot reach the numbers.
  await createDocuments(sdk, bot0, { contractId, docType: 'multiVote', datas: [ballot(singlePollId, 1)] });
  await settle();
  const afterNoise = await groupedCounts(sdk, 'vote', singlePollId);
  check('off-doctype ballots cannot move a single-choice tally',
    JSON.stringify(afterNoise.slice(0, 2)) === '[1,1]', JSON.stringify(afterNoise.slice(0, 2)));

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
