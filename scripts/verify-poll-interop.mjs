/**
 * Cross-app acceptance check for Pollr: writes polls and ballots the way a hand-rolled client such as the
 * standalone Pollr app (https://pastapastapasta.github.io/pollr) does — raw batch state transitions signed by the
 * e2e bot identities 0 (poll author) and 1 (second voter) — and checks that the reads Yappr's poll card makes
 * (grouped and per-option counts, a full ballot scan) agree with what was written.
 *
 * Two contract shapes, picked by `--topology`:
 *
 *   v7 (default; the checked-in `contracts/pollr-contract.json`, Dash Platform 5.0.0-beta.5): `poll` carries
 *     `{ question, options[], multiChoice (always written), endsAt (required) }`; a voter holds ONE stored, mutable
 *     `vote` per poll, `{ pollId, choices }`, where `choices` is the typed array of the option indices picked (one
 *     element on a single-choice poll, several on a multi-choice one) and an ABSENT `choices` is a withdrawn ballot.
 *     A second create by the same voter is 40105; a change of mind, a different selection and a withdrawal are a
 *     REPLACE of the one ballot. The contract judges `choices` against the poll it names (10422 `singleChoice`,
 *     `choicesAreOptions`, `choicesAreOptionsHigh`) and every write must land by the poll's endsAt (40127).
 *   v3 — the externally owned testnet contract the standalone app reads today (`GBCR8Jqt…`): option0..option9,
 *     `vote` for single-choice polls and `multiVote` for multi-choice, both carrying pollOwnerId. The standalone
 *     app has to move to the v7 shapes before it can share polls with a v7 Yappr.
 *
 * Checks, both topologies unless noted:
 *   1. poll create round-trips (question, options, multiChoice)
 *   2. a multi-choice selection lands — v7: as ONE ballot holding two choices, read back; v3: as a ballot batch
 *      (one document per choice; falls back to one transition per document while the protocol caps a batch at a
 *      single transition, and says so)
 *   3. a second selection by the same voter on the poll is rejected (v7: 40105 whatever it holds; v3: a repeat of
 *      the same choice, while a distinct one is accepted)
 *   4. single-choice enforcement: a voter's second create is rejected, another voter's is accepted
 *   5. the poll's mode cannot be bent: v3 — a multiVote written against a single-choice poll cannot move its tally;
 *      v7 — a two-element ballot on a single-choice poll (10422 singleChoice), an element equal to the option count
 *      (10422 choicesAreOptions) and one four past it (10422 choicesAreOptionsHigh) are rejected
 *   6. count-tree tallies: grouped per-option count and per-option counts (v7: `containsAny` grouped by `choices`
 *      and `contains` per option on the typed-array element index; v3: `in` grouped and `==`), cross-checked by a
 *      full scan; v7 also counts every ballot (byPoll)
 *   7. v7 only: changing a selection and withdrawing by replace move the tally of a single-choice and a
 *      multi-choice poll, and a withdrawn ballot still counts in byPoll
 *
 * Run:  node scripts/verify-poll-interop.mjs --contract <pollrContractId> [--topology v7|v3]
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
import { decodeIntGroupKey } from './battery-lib.mjs';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';
import { constraintViolation } from './property-constraint-cases.mjs';
import { connectSdk } from './sdk-env.mjs';
import { deriveDocumentIdBytes } from './seed/seed-lib.mjs';

const SDK_TIMEOUT_MS = 30000;
/** DIP-30: lower 40 bits of the identity contract nonce are the sequence number. */
const SEQUENCE_MASK = (1n << 40n) - 1n;
const TOPOLOGIES = ['v7', 'v3'];
/** A second create on a unique (pollId, $ownerId) key. */
const DUPLICATE_UNIQUE = /\b40105\b|duplicate unique properties/i;

function parseArgs(argv) {
  const args = { contract: null, topology: 'v7' };
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
 * v7: replaces a ballot at the next revision with `data` (no `choices` = withdrawn). A 504 on the wait is settled
 * by reading the revision back; a refusal leaves the revision where it was and is re-thrown with its reason.
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
const isV7 = args.topology === 'v7';

const ALL_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * The two topologies' write and read shapes. A `poll` handle is `{ id, ownerId, optionCount, multiChoice, endsAt }`.
 * `ballots` returns the datas of one selection (v7: ONE document holding every choice; v3: one per choice) and
 * `ballotType` its doctype; `options` reads a stored poll's option labels; `picked` the option indices a stored
 * ballot counts under; `tally` is the grouped-count and per-option read the poll card makes.
 */
const SHAPES = {
  v7: {
    poll: ({ question, options, multiChoice, endsAt }) => ({ question, options, multiChoice, endsAt }),
    options: (stored) => stored?.options ?? [],
    ballotType: () => 'vote',
    // `choices` undefined = withdrawn (the field is absent).
    ballot: (poll, choices) => ({ pollId: bs58.decode(poll.id), ...(choices === undefined ? {} : { choices }) }),
    ballots: (poll, choices) => [SHAPES.v7.ballot(poll, choices)],
    picked: (ballot) => (ballot.choices === undefined || ballot.choices === null ? [] : Array.from(ballot.choices, Number)),
    // byPollChoice is a typed-array ELEMENT index: a ballot counts once under each of its choices.
    tally: { field: 'choices', grouped: ['choices', 'containsAny', ALL_CHOICES], single: 'contains' },
    // Every ballot, ticked or not, through byPollVoter: the scan Yappr's "my ballot" read pages through.
    scan: (pollId) => ({ where: [['pollId', '==', pollId]], orderBy: [['pollId', 'asc'], ['$ownerId', 'asc']] }),
  },
  v3: {
    // multiChoice is omitted entirely on a single-choice v3 poll — absent means single choice.
    poll: ({ question, options, multiChoice, endsAt }) => ({
      question, ...Object.fromEntries(options.map((option, index) => [`option${index}`, option])),
      ...(multiChoice ? { multiChoice: true } : {}), endsAt,
    }),
    options: (stored) => ALL_CHOICES.map((index) => stored?.[`option${index}`]).filter((option) => option !== undefined && option !== null),
    ballotType: (poll) => (poll.multiChoice ? 'multiVote' : 'vote'),
    ballots: (poll, choices) => choices.map((choice) => ({ pollId: bs58.decode(poll.id), pollOwnerId: bs58.decode(poll.ownerId), choice })),
    picked: (ballot) => (ballot.choice === undefined || ballot.choice === null ? [] : [Number(ballot.choice)]),
    tally: { field: 'choice', grouped: ['choice', 'in', ALL_CHOICES], single: '==' },
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

/**
 * Per-option counts in one grouped count. The group key is the hex of Platform's integer byte: 0x80 + option on
 * older chains, the plain byte on PV14 from beta.5 (`decodeIntGroupKey` reads both).
 */
async function groupedCounts(sdk, docType, pollId) {
  const raw = await sdk.documents.count({
    dataContractId: contractId,
    documentTypeName: docType,
    where: [['pollId', '==', pollId], shape.tally.grouped],
    groupBy: [shape.tally.field],
  });
  const counts = new Array(10).fill(0);
  for (const [key, value] of countEntries(raw)) {
    if (key === '') continue;
    const option = decodeIntGroupKey(key);
    if (option === null || option < 0 || option >= counts.length) throw new Error(`group key ${JSON.stringify(key)} is not an option index`);
    counts[option] = Number(value);
  }
  return counts;
}

/** The guaranteed fallback path: one count per option. */
async function perOptionCounts(sdk, docType, pollId, upTo) {
  const counts = [];
  for (let choice = 0; choice < upTo; choice++) {
    const raw = await sdk.documents.count({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [['pollId', '==', pollId], [shape.tally.field, shape.tally.single, choice]],
    });
    const n = raw instanceof Map ? raw.get('') : raw?.[''];
    counts.push(Number(n ?? 0));
  }
  return counts;
}

/** Every ballot on a poll (withdrawn ones included), counted by byPoll: what the owner's noBallots delete rule reads. */
async function ballotCount(sdk, docType, pollId) {
  const raw = await sdk.documents.count({ dataContractId: contractId, documentTypeName: docType, where: [['pollId', '==', pollId]] });
  const n = raw instanceof Map ? raw.get('') : raw?.[''];
  return Number(n ?? 0);
}

/** Every ballot on a poll, tallied by hand: what a client without count trees would do. */
async function scanTally(sdk, docType, pollId, upTo) {
  const raw = await sdk.documents.query({ dataContractId: contractId, documentTypeName: docType, ...shape.scan(pollId), limit: 100 });
  const ballots = countEntries(raw).map(([, d]) => (d?.toObject ? d.toObject() : d));
  const scanned = new Array(upTo).fill(0);
  for (const ballot of ballots) for (const option of shape.picked(ballot)) scanned[option] += 1;
  return { ballots: ballots.length, scanned };
}

async function readPoll(sdk, id) {
  const raw = await sdk.documents.query({ dataContractId: contractId, documentTypeName: 'poll', where: [['$id', '==', id]] });
  const doc = countEntries(raw)[0]?.[1];
  return doc?.toObject ? doc.toObject() : doc;
}

/** Count trees settle behind the read quorum; give them a beat after a write. */
const settle = () => new Promise((r) => setTimeout(r, 3000));

const json = JSON.stringify;

try {
  const sdk = await connectSdk({ timeoutMs: SDK_TIMEOUT_MS });
  const bot0 = await botSigner(sdk, 0);
  const bot1 = await botSigner(sdk, 1);
  console.log(`connected; contract=${contractId} (${args.topology}) bot0=${bot0.ownerId} bot1=${bot1.ownerId}`);

  // v7 polls must close within 31 days of creation; a week suits both shapes.
  const endsAt = Date.now() + 7 * 24 * 3600 * 1000;
  async function createPoll(fields) {
    const { ids: [id] } = await createDocuments(sdk, bot0, { contractId, docType: 'poll', datas: [shape.poll({ ...fields, endsAt })] });
    return { id, ownerId: bot0.ownerId, optionCount: fields.options.length, multiChoice: fields.multiChoice, endsAt };
  }
  /** Casts `choices` on a poll as `signer`: v7 one ballot, v3 one document per choice. */
  const vote = (signer, poll, choices) => createDocuments(sdk, signer, {
    contractId, docType: shape.ballotType(poll), datas: shape.ballots(poll, choices),
  });
  /** v7: the stored ballot `id`'s choices, as a number array (undefined = withdrawn). */
  const choicesAt = async (id) => {
    const stored = await sdk.documents.get(contractId, 'vote', id);
    const fields = stored?.toObject ? stored.toObject() : stored;
    return fields ? shape.picked(fields) : null;
  };

  // ============================ multi-choice poll ============================
  console.log('');
  console.log(`--- multi-choice poll (${shape.ballotType({ multiChoice: true })}) ---`);

  const multiOptions = ['O(1) tallies', 'Grouped counts', 'Prefix totals'];
  const multiPoll = await createPoll({ question: 'Which count-tree feature matters most?', options: multiOptions, multiChoice: true });
  const multiType = shape.ballotType(multiPoll);
  console.log(`multi poll created: ${multiPoll.id}`);

  const multiObj = await readPoll(sdk, multiPoll.id);
  check('1. multi poll round-trip', multiObj?.question === 'Which count-tree feature matters most?'
    && json(shape.options(multiObj)) === json(multiOptions) && multiObj?.multiChoice === true,
    `question=${json(multiObj?.question)} options=${json(shape.options(multiObj))} multiChoice=${json(multiObj?.multiChoice)}`);

  // bot1 casts a two-choice selection; bot0 casts one.
  let multiResult = null;
  try {
    multiResult = await vote(bot1, multiPoll, [0, 2]);
  } catch (e) {
    console.log(`  multi-ballot error: ${describeErr(e)}`);
  }
  if (isV7) {
    const stored = multiResult ? await choicesAt(multiResult.ids[0]) : null;
    check('2. a multi-choice selection lands as ONE ballot holding both choices', multiResult?.ids.length === 1 && json(stored?.sort((a, b) => a - b)) === '[0,2]',
      `ballots=${multiResult?.ids.length} choices=${json(stored)}`);
  } else {
    check('2. a multi-choice ballot lands (2 selections)', multiResult !== null, `mode=${multiResult?.mode}`);
  }

  await vote(bot0, multiPoll, [1]);
  check('2b. a second voter records a selection', true);

  if (isV7) {
    // One ballot per (poll, voter): whatever a second create holds, it is a duplicate; a change is a replace (7).
    await expectRejected('3. the same voter\'s SECOND create on the poll is rejected (40105), even for a different option', () => vote(bot1, multiPoll, [1]), DUPLICATE_UNIQUE);
  } else {
    await expectRejected(`3. ${multiType}: repeat of the same choice rejected`, () => vote(bot1, multiPoll, [0]));
    // The point of multi-choice: a *different* choice from the same voter is fine.
    await vote(bot1, multiPoll, [1]);
    check(`3b. ${multiType}: a distinct additional choice is accepted`, true);
  }

  await settle();

  // v7: bot1 [0,2] + bot0 [1] = [1,1,1]; v3: bot1 0,2,1 + bot0 1 = [1,2,1].
  const multiWant = isV7 ? [1, 1, 1, 0] : [1, 2, 1, 0];
  const multiGrouped = await groupedCounts(sdk, multiType, multiPoll.id);
  check(`6. ${multiType} grouped counts == ${json(multiWant.slice(0, 3))}`,
    json(multiGrouped.slice(0, 3)) === json(multiWant.slice(0, 3)), json(multiGrouped.slice(0, 3)));

  const multiPer = await perOptionCounts(sdk, multiType, multiPoll.id, 4);
  check(`6b. ${multiType} per-option counts == ${json(multiWant)}`, json(multiPer) === json(multiWant), json(multiPer));

  if (!isV7) {
    // v3 drops v2's `pollTotal` index: it only ever fed a misleading
    // "zero counts + grand total" fallback, and the sum of choiceCounts is the
    // same number. A bare pollId count must therefore no longer resolve.
    await expectRejected('pollTotal index is gone (bare pollId count unavailable)', () =>
      sdk.documents.count({ dataContractId: contractId, documentTypeName: multiType, where: [['pollId', '==', multiPoll.id]] }));
  }

  const multiScan = await scanTally(sdk, multiType, multiPoll.id, 4);
  check(`6c. ${multiType} full scan matches count trees`,
    multiScan.ballots === (isV7 ? 2 : 4) && json(multiScan.scanned) === json(multiWant),
    `ballots=${multiScan.ballots} scanned=${json(multiScan.scanned)}`);

  // =========================== single-choice poll ============================
  console.log('');
  console.log('--- single-choice poll (vote) ---');

  const singlePoll = await createPoll({ question: 'Ship it?', options: ['Yes', 'No'], multiChoice: false });
  console.log(`single poll created: ${singlePoll.id}`);

  const singleObj = await readPoll(sdk, singlePoll.id);
  // v3 omits multiChoice on a single-choice poll; v7 requires it, written as false.
  check(`1b. single poll round-trip (multiChoice ${isV7 ? 'false' : 'absent'})`,
    singleObj?.question === 'Ship it?' && (isV7 ? singleObj?.multiChoice === false : !singleObj?.multiChoice),
    `multiChoice=${json(singleObj?.multiChoice)}`);

  const { ids: [bot0Ballot] } = await vote(bot0, singlePoll, [0]);
  check('4. single-choice ballot lands', true);

  // v3: the voterBallot index is (pollId, $ownerId) with no choice. v7: byPollVoter is unique on the same pair —
  // a change of mind is a replace.
  await expectRejected("4b. vote: same voter's SECOND, DIFFERENT choice is rejected", () => vote(bot0, singlePoll, [1]), isV7 ? DUPLICATE_UNIQUE : null);

  // A different identity is of course unaffected.
  const { ids: [bot1Ballot] } = await vote(bot1, singlePoll, [1]);
  check('4c. vote: a different voter is unaffected', true);

  await settle();

  const singleGrouped = await groupedCounts(sdk, 'vote', singlePoll.id);
  check('6d. vote grouped counts == [1,1]',
    json(singleGrouped.slice(0, 2)) === '[1,1]', json(singleGrouped.slice(0, 2)));

  if (isV7) {
    // One doctype for both modes, so the mode is held by the contract, which reads the poll the ballot names. A
    // fresh single-choice poll gives bot1 a clean (poll, voter) key, so no 40105 can fire before the rule does.
    const rulesPoll = await createPoll({ question: 'Rules?', options: ['Yes', 'No'], multiChoice: false });
    await expectRejected('5. a two-element ballot on a single-choice poll is rejected (10422 singleChoice)',
      () => vote(bot1, rulesPoll, [0, 1]), constraintViolation('singleChoice'));
    await expectRejected('5b. an element equal to the option count is rejected (10422 choicesAreOptions)',
      () => vote(bot1, rulesPoll, [2]), constraintViolation('choicesAreOptions'));
    await expectRejected('5c. an element four past the option count is rejected (10422 choicesAreOptionsHigh)',
      () => vote(bot1, rulesPoll, [6]), constraintViolation('choicesAreOptionsHigh'));

    // A change of mind and a withdrawal are replaces of the voter's one ballot.
    await replaceBallot(sdk, bot1, { contractId, id: bot1Ballot, data: shape.ballot(singlePoll, [0]) });
    await settle();
    const changed = await groupedCounts(sdk, 'vote', singlePoll.id);
    check('7. vote: changing choice 1 → 0 by replace moves the tally to [2,0]',
      json(changed.slice(0, 2)) === '[2,0]', json(changed.slice(0, 2)));

    await replaceBallot(sdk, bot0, { contractId, id: bot0Ballot, data: shape.ballot(singlePoll, undefined) });
    await settle();
    const withdrawn = await perOptionCounts(sdk, 'vote', singlePoll.id, 2);
    const scan = await scanTally(sdk, 'vote', singlePoll.id, 2);
    const ballots = await ballotCount(sdk, 'vote', singlePoll.id);
    check('7b. vote: a withdrawn ballot (choices dropped) leaves the tally but stays a document that byPoll counts',
      json(withdrawn) === '[1,0]' && scan.ballots === 2 && ballots === 2 && json(scan.scanned) === '[1,0]',
      `perOption=${json(withdrawn)} ballots=${scan.ballots} byPoll=${ballots} scanned=${json(scan.scanned)}`);

    // A multi-choice voter re-picks the whole selection by one replace: bot1 [0,2] → [0,1,2].
    await replaceBallot(sdk, bot1, { contractId, id: multiResult.ids[0], data: shape.ballot(multiPoll, [0, 1, 2]) });
    await settle();
    const widened = await groupedCounts(sdk, 'vote', multiPoll.id);
    const widenedScan = await scanTally(sdk, 'vote', multiPoll.id, 4);
    check('7c. vote: widening a multi-choice ballot [0,2] → [0,1,2] by replace moves the tally to [1,2,1] and still counts two ballots',
      json(widened.slice(0, 3)) === '[1,2,1]' && widenedScan.ballots === 2 && json(widenedScan.scanned) === '[1,2,1,0]',
      `grouped=${json(widened.slice(0, 3))} ballots=${widenedScan.ballots} scanned=${json(widenedScan.scanned)}`);
  } else {
    // Doctype isolation. Nothing stops a hand-rolled client writing multiVote
    // documents against a single-choice poll — but the tally only ever reads the
    // doctype the poll's mode selects, so they cannot reach the numbers.
    await vote(bot0, { ...singlePoll, multiChoice: true }, [1]);
    await settle();
    const afterNoise = await groupedCounts(sdk, 'vote', singlePoll.id);
    check('5. off-doctype ballots cannot move a single-choice tally',
      json(afterNoise.slice(0, 2)) === '[1,1]', json(afterNoise.slice(0, 2)));
  }

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
