/**
 * Cross-app acceptance check for Pollr: writes polls and ballots the way a hand-rolled client such as the
 * standalone Pollr app (https://pastapastapasta.github.io/pollr) does — raw batch state transitions signed by the
 * e2e bot identities 0 (poll author) and 1 (second voter) — and checks that the reads Yappr's poll card makes
 * (grouped and per-choice counts, a full ballot scan) agree with what was written.
 *
 * Two contract shapes, picked by `--topology`:
 *
 *   v5 (default; also the one for a v6 contract, the checked-in `contracts/pollr-contract.json`, whose poll and
 *     ballot shapes are v5's — v6 only adds the owner's delete before the first ballot, which verify-pollr.mjs p8
 *     proves): `poll` carries options[] / optionCount / multiChoice (always
 *     written) / endsAt (required); every ballot is a stored, mutable `vote` with a `slot` (0 on a single-choice
 *     poll, the option itself on a multi-choice one) and the poll's optionCount / multiChoice / endsAt copied in,
 *     bound by the pollId reference (40127 on a mismatch). A voter changes or withdraws a single-choice vote by
 *     REPLACING its ballot; a second create is 40105.
 *   v3 — the externally owned testnet contract the standalone app reads today (`GBCR8Jqt…`): option0..option9,
 *     `vote` for single-choice polls and `multiVote` for multi-choice, both carrying pollOwnerId. The standalone
 *     app has to move to the v5 shapes before it can share polls with a v5 Yappr.
 *
 * Checks, both topologies:
 *   1. poll create round-trips (question, options, multiChoice)
 *   2. a multi-choice ballot as ONE batch state transition (falls back to one transition per document while the
 *      protocol caps a batch at a single transition, and says so)
 *   3. a repeat of the same multi-choice selection is rejected, a distinct one is accepted
 *   4. single-choice enforcement: a voter's second create is rejected, another voter's is accepted
 *   5. the poll's mode cannot be bent: v3 — a multiVote written against a single-choice poll cannot move its tally;
 *      v5 — a slot-1 ballot on a single-choice poll (10422 singleUsesSlotZero) and a ballot claiming the poll is
 *      multi-choice (40127) are rejected
 *   6. count-tree tallies: grouped per-choice count and per-choice equality counts, cross-checked by a full scan
 *   7. v5 only: changing and withdrawing a single-choice vote by replace moves the tally
 *
 * Run:  node scripts/verify-poll-interop.mjs --contract <pollrContractId> [--topology v5|v3]
 */
import {
  BatchTransition,
  BatchedTransition,
  Document,
  DocumentCreateTransition,
  IdentitySigner,
  PlatformVersion,
  PrivateKey,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';
import { connectSdk } from './sdk-env.mjs';
import { deriveDocumentIdBytes } from './seed/seed-lib.mjs';

const SDK_TIMEOUT_MS = 30000;
/** DIP-30: lower 40 bits of the identity contract nonce are the sequence number. */
const SEQUENCE_MASK = (1n << 40n) - 1n;
const TOPOLOGIES = ['v5', 'v3'];

function parseArgs(argv) {
  const args = { contract: null, topology: 'v5' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--topology': args.topology = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('--contract <pollrContractId> is required');
  if (!TOPOLOGIES.includes(args.topology)) throw new Error(`--topology takes ${TOPOLOGIES.join(' or ')}`);
  return args;
}

let failures = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

/** The id commits to the create transition's nonce (protocol 14), so it is derived from the nonce the batch carries. */
function canonicalDoc({ contractId, docType, ownerId, entropy, data, nonce }) {
  const idBytes = deriveDocumentIdBytes({ contractId, ownerId, docType, entropy, nonce });
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
    canonicalDoc({ contractId, docType, ownerId, entropy: crypto.getRandomValues(new Uint8Array(32)), data, nonce })
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
    await settle();
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

/**
 * v5: replaces a ballot at the next revision with `data` (no `choice` = withdrawn). A 504 on the wait is settled
 * by reading the revision back.
 */
async function replaceBallot(sdk, signerInfo, { contractId, id, data }) {
  const current = await sdk.documents.get(contractId, 'vote', id);
  if (!current) throw new Error(`ballot ${id} does not read back`);
  const revision = BigInt(current.revision) + 1n;
  const document = Document.fromObject({
    $formatVersion: '0', $id: bs58.decode(id), $ownerId: bs58.decode(signerInfo.ownerId), $dataContractId: bs58.decode(contractId),
    $type: 'vote', $revision: revision, ...data,
  }, PlatformVersion.current());
  try {
    await sdk.documents.replace({ document, identityKey: signerInfo.identityKey, signer: signerInfo.signer });
  } catch (e) {
    console.log(`  (replace reported: ${describeErr(e).slice(0, 160)} — confirming by read)`);
    await settle();
    const stored = await sdk.documents.get(contractId, 'vote', id);
    if (BigInt(stored?.revision ?? 0) < revision) throw e;
  }
}

async function botSigner(sdk, index) {
  const ownerId = loadIdentityIds()[index];
  if (!ownerId) throw new Error(`No bot identity at index ${index} in E2E_IDENTITY_IDS`);
  const wif = criticalAuthKey(deriveIdentityKeys(index)).wif;
  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error(`Identity ${ownerId} not found`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wif);
  return { ownerId, wif, identityKey, signer };
}

function countEntries(raw) {
  return raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw ?? {});
}

const args = parseArgs(process.argv.slice(2));
const contractId = args.contract;
const isV5 = args.topology === 'v5';

const ALL_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Grouped count keys are the hex of Platform's tagged integer byte: 0x80 + choice. */
const CHOICE_KEY_OFFSET = 0x80;

/**
 * The two topologies' write shapes. A `poll` handle is `{ id, ownerId, optionCount, multiChoice, endsAt }`.
 * `ballot` returns the doctype and data of one selection; `options` reads a stored poll's option labels.
 */
const SHAPES = {
  v5: {
    poll: ({ question, options, multiChoice, endsAt }) => ({ question, options, optionCount: options.length, multiChoice, endsAt }),
    options: (stored) => stored?.options ?? [],
    ballotType: () => 'vote',
    ballot: (poll, choice, overrides = {}) => ({
      pollId: bs58.decode(poll.id), slot: poll.multiChoice ? choice : 0, ...(choice === undefined ? {} : { choice }),
      pollOptionCount: poll.optionCount, pollMultiChoice: poll.multiChoice, pollEndsAt: poll.endsAt, ...overrides,
    }),
    // Every ballot, ticked or not, through byPollVoter: the scan Yappr's "my ballots" read pages through.
    scan: (pollId) => ({ where: [['pollId', '==', pollId]], orderBy: [['pollId', 'asc'], ['$ownerId', 'asc'], ['slot', 'asc']] }),
  },
  v3: {
    // multiChoice is omitted entirely on a single-choice v3 poll — absent means single choice.
    poll: ({ question, options, multiChoice, endsAt }) => ({
      question, ...Object.fromEntries(options.map((option, index) => [`option${index}`, option])),
      ...(multiChoice ? { multiChoice: true } : {}), endsAt,
    }),
    options: (stored) => ALL_CHOICES.map((index) => stored?.[`option${index}`]).filter((option) => option !== undefined && option !== null),
    ballotType: (poll) => (poll.multiChoice ? 'multiVote' : 'vote'),
    ballot: (poll, choice) => ({ pollId: bs58.decode(poll.id), pollOwnerId: bs58.decode(poll.ownerId), choice }),
    scan: (pollId) => ({ where: [['pollId', '==', pollId]], orderBy: [['$createdAt', 'asc']] }),
  },
};
const shape = SHAPES[args.topology];

/** Assert Platform refuses a write. The rejection text is echoed for the log. */
async function expectRejected(label, run, pattern = null) {
  try {
    await run();
    check(label, false, 'accepted (BAD)');
  } catch (e) {
    const text = describeErr(e);
    check(label, pattern === null || pattern.test(text), text.slice(0, 160));
  }
}

/** Per-choice counts off the `choice` count tree, in one grouped count. */
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

/** Every ballot on a poll, tallied by hand: what a client without count trees would do. */
async function scanTally(sdk, docType, pollId, upTo) {
  const raw = await sdk.documents.query({ dataContractId: contractId, documentTypeName: docType, ...shape.scan(pollId), limit: 100 });
  const ballots = countEntries(raw).map(([, d]) => (d?.toObject ? d.toObject() : d));
  const scanned = new Array(upTo).fill(0);
  for (const ballot of ballots) if (ballot.choice !== undefined && ballot.choice !== null) scanned[Number(ballot.choice)] += 1;
  return { ballots: ballots.length, scanned };
}

async function readPoll(sdk, id) {
  const raw = await sdk.documents.query({ dataContractId: contractId, documentTypeName: 'poll', where: [['$id', '==', id]] });
  const doc = countEntries(raw)[0]?.[1];
  return doc?.toObject ? doc.toObject() : doc;
}

/** Count trees settle behind the read quorum; give them a beat after a write. */
const settle = () => new Promise((r) => setTimeout(r, 3000));

try {
  const sdk = await connectSdk({ timeoutMs: SDK_TIMEOUT_MS });
  const bot0 = await botSigner(sdk, 0);
  const bot1 = await botSigner(sdk, 1);
  console.log(`connected; contract=${contractId} (${args.topology}) bot0=${bot0.ownerId} bot1=${bot1.ownerId}`);

  // v5 polls must close within 31 days of creation; a week suits both shapes.
  const endsAt = Date.now() + 7 * 24 * 3600 * 1000;
  async function createPoll(fields) {
    const { ids: [id] } = await createDocuments(sdk, bot0, { contractId, docType: 'poll', datas: [shape.poll({ ...fields, endsAt })] });
    return { id, ownerId: bot0.ownerId, optionCount: fields.options.length, multiChoice: fields.multiChoice, endsAt };
  }
  const vote = (signer, poll, choices, overrides) => createDocuments(sdk, signer, {
    contractId, docType: shape.ballotType(poll), datas: choices.map((choice) => shape.ballot(poll, choice, overrides)),
  });

  // ============================ multi-choice poll ============================
  console.log('');
  console.log(`--- multi-choice poll (${shape.ballotType({ multiChoice: true })}) ---`);

  const multiOptions = ['O(1) tallies', 'Grouped counts', 'Prefix totals'];
  const multiPoll = await createPoll({ question: 'Which count-tree feature matters most?', options: multiOptions, multiChoice: true });
  const multiType = shape.ballotType(multiPoll);
  console.log(`multi poll created: ${multiPoll.id}`);

  const multiObj = await readPoll(sdk, multiPoll.id);
  check('multi poll round-trip', multiObj?.question === 'Which count-tree feature matters most?'
    && JSON.stringify(shape.options(multiObj)) === JSON.stringify(multiOptions) && multiObj?.multiChoice === true,
    `question=${JSON.stringify(multiObj?.question)} options=${JSON.stringify(shape.options(multiObj))} multiChoice=${JSON.stringify(multiObj?.multiChoice)}`);

  // bot1 casts a two-choice ballot; bot0 casts one.
  let multiMode = null;
  try {
    ({ mode: multiMode } = await vote(bot1, multiPoll, [0, 2]));
  } catch (e) {
    console.log(`  multi-ballot error: ${describeErr(e)}`);
  }
  check('multi-choice ballot lands (2 selections)', multiMode !== null, `mode=${multiMode}`);

  await vote(bot0, multiPoll, [1]);
  check('second voter records a selection', true);

  await expectRejected(`${multiType}: repeat of the same choice rejected`, () => vote(bot1, multiPoll, [0]));

  // The point of multi-choice: a *different* choice from the same voter is fine.
  await vote(bot1, multiPoll, [1]);
  check(`${multiType}: a distinct additional choice is accepted`, true);

  await settle();

  const multiGrouped = await groupedCounts(sdk, multiType, multiPoll.id);
  check(`${multiType} grouped counts == [1,2,1]`,
    JSON.stringify(multiGrouped.slice(0, 3)) === '[1,2,1]', JSON.stringify(multiGrouped.slice(0, 3)));

  const multiEquality = await equalityCounts(sdk, multiType, multiPoll.id, 4);
  check(`${multiType} per-choice equality counts == [1,2,1,0]`,
    JSON.stringify(multiEquality) === '[1,2,1,0]', JSON.stringify(multiEquality));

  if (!isV5) {
    // v3 drops v2's `pollTotal` index: it only ever fed a misleading
    // "zero counts + grand total" fallback, and the sum of choiceCounts is the
    // same number. A bare pollId count must therefore no longer resolve.
    await expectRejected('pollTotal index is gone (bare pollId count unavailable)', () =>
      sdk.documents.count({ dataContractId: contractId, documentTypeName: multiType, where: [['pollId', '==', multiPoll.id]] }));
  }

  const multiScan = await scanTally(sdk, multiType, multiPoll.id, 4);
  check(`${multiType} full scan matches count trees`,
    multiScan.ballots === 4 && JSON.stringify(multiScan.scanned) === '[1,2,1,0]',
    `ballots=${multiScan.ballots} scanned=${JSON.stringify(multiScan.scanned)}`);

  // =========================== single-choice poll ============================
  console.log('');
  console.log('--- single-choice poll (vote) ---');

  const singlePoll = await createPoll({ question: 'Ship it?', options: ['Yes', 'No'], multiChoice: false });
  console.log(`single poll created: ${singlePoll.id}`);

  const singleObj = await readPoll(sdk, singlePoll.id);
  // v3 omits multiChoice on a single-choice poll; v5 requires it, written as false.
  check(`single poll round-trip (multiChoice ${isV5 ? 'false' : 'absent'})`,
    singleObj?.question === 'Ship it?' && (isV5 ? singleObj?.multiChoice === false : !singleObj?.multiChoice),
    `multiChoice=${JSON.stringify(singleObj?.multiChoice)}`);

  const { ids: [bot0Ballot] } = await vote(bot0, singlePoll, [0]);
  check('single-choice ballot lands', true);

  // v3: the voterBallot index is (pollId, $ownerId) with no choice. v5: byPollVoter is unique on
  // (pollId, $ownerId, slot) and a single-choice ballot always sits in slot 0 — a change of mind is a replace.
  await expectRejected("vote: same voter's SECOND, DIFFERENT choice is rejected", () => vote(bot0, singlePoll, [1]));

  // A different identity is of course unaffected.
  const { ids: [bot1Ballot] } = await vote(bot1, singlePoll, [1]);
  check('vote: a different voter is unaffected', true);

  await settle();

  const singleGrouped = await groupedCounts(sdk, 'vote', singlePoll.id);
  check('vote grouped counts == [1,1]',
    JSON.stringify(singleGrouped.slice(0, 2)) === '[1,1]', JSON.stringify(singleGrouped.slice(0, 2)));

  if (isV5) {
    // One doctype for both modes, so the mode is held by the contract: a second slot on a single-choice poll breaks
    // singleUsesSlotZero, and a ballot that claims the poll is multi-choice disagrees with the poll (40127).
    await expectRejected('a slot-1 ballot on a single-choice poll is rejected (10422 singleUsesSlotZero)',
      () => vote(bot1, singlePoll, [1], { slot: 1 }), /singleUsesSlotZero/);
    await expectRejected('a ballot claiming pollMultiChoice on a single-choice poll is rejected (40127)',
      () => vote(bot0, { ...singlePoll, multiChoice: true }, [1]), /\b40127\b|does not agree with the referenced document/i);

    // A change of mind and a withdrawal are replaces of the voter's one ballot.
    await replaceBallot(sdk, bot1, { contractId, id: bot1Ballot, data: shape.ballot(singlePoll, 0) });
    await settle();
    const changed = await groupedCounts(sdk, 'vote', singlePoll.id);
    check('vote: changing choice 1 → 0 by replace moves the tally to [2,0]',
      JSON.stringify(changed.slice(0, 2)) === '[2,0]', JSON.stringify(changed.slice(0, 2)));

    await replaceBallot(sdk, bot0, { contractId, id: bot0Ballot, data: shape.ballot(singlePoll, undefined) });
    await settle();
    const withdrawn = await equalityCounts(sdk, 'vote', singlePoll.id, 2);
    const scan = await scanTally(sdk, 'vote', singlePoll.id, 2);
    check('vote: a withdrawn ballot (choice dropped) leaves the tally but stays a document',
      JSON.stringify(withdrawn) === '[1,0]' && scan.ballots === 2 && JSON.stringify(scan.scanned) === '[1,0]',
      `equality=${JSON.stringify(withdrawn)} ballots=${scan.ballots} scanned=${JSON.stringify(scan.scanned)}`);
  } else {
    // Doctype isolation. Nothing stops a hand-rolled client writing multiVote
    // documents against a single-choice poll — but the tally only ever reads the
    // doctype the poll's mode selects, so they cannot reach the numbers.
    await vote(bot0, { ...singlePoll, multiChoice: true }, [1]);
    await settle();
    const afterNoise = await groupedCounts(sdk, 'vote', singlePoll.id);
    check('off-doctype ballots cannot move a single-choice tally',
      JSON.stringify(afterNoise.slice(0, 2)) === '[1,1]', JSON.stringify(afterNoise.slice(0, 2)));
  }

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
