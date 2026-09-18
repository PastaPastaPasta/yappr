/**
 * Registration-day battery for **YAPP tips** (docs/TIPS_YAPP.md).
 *
 * Tips are not a Yappr contract at all: a tip is a YAPP token transfer, and the
 * proof is the `transfer` document Platform writes into the SYSTEM
 * token-history contract because YAPP sets `keepsTransferHistory`. This battery
 * proves that end to end on a live devnet.
 *
 * Actors are seed-ledger personas (`.seed-identities.local.json`): a TIPPER and
 * a CREATOR. The tipper signs with its CRITICAL auth key — every batch carrying
 * a token transition needs one.
 *
 * Cases:
 *   t1  transfer: tipper sends `--amount` YAPP to the creator with the tip note
 *       `yappr:tip:v1:post:<id>`; both balances move by exactly that amount
 *   t2  proof: the `transfer` row is readable off the token-history `to` index
 *       for (tokenId, creator), carrying the exact amount, the tipper as
 *       $ownerId and the note verbatim
 *   t3  attribution: the client-side filter tip-history-service applies (parse
 *       the note, keep the rows naming this post) finds exactly this tip, and
 *       does NOT pick up the untagged control transfer sent alongside it
 *   t4  from-index: the same row is reachable from the tipper's side
 *   t5  unsigned builder: the bytes the wallet path hands to a dash-st: URI
 *       decode back (StateTransition.fromBytes) to a token transfer naming the
 *       right recipient, amount and note — built, decoded, never broadcast
 *
 * Run:
 *   NETWORK=devnet node scripts/verify-tips.mjs \
 *     [--tipper 240] [--creator 241] [--amount 5] [--only t2,t3]
 */
import {
  BatchTransition,
  BatchedTransition,
  StateTransition,
  TokenBaseTransition,
  TokenTransferTransition,
  TokenTransition,
  ensureInitialized,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { createBattery, runCases, parseOnly, settle } from './battery-lib.mjs';
import {
  YAPP_TOKEN_POSITION,
  createSdkHandle,
  describeErr,
  socialContractId,
} from './seed/seed-lib.mjs';

// The system token-history contract — identical on every chain.
const TOKEN_HISTORY_CONTRACT_ID = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF';
const TIP_NOTE_PREFIX = 'yappr:tip:v1:';
const SEQUENCE_MASK = (1n << 40n) - 1n;

/** Mirrors lib/tip-note.ts — kept literal here so the battery checks the encoding, not the app's copy of it. */
const encodeTipNote = (kind, targetId, message) =>
  message ? `${TIP_NOTE_PREFIX}${kind}:${targetId}\n${message}` : `${TIP_NOTE_PREFIX}${kind}:${targetId}`;

function parseTipNote(note) {
  if (typeof note !== 'string' || !note.startsWith(TIP_NOTE_PREFIX)) return null;
  const newline = note.indexOf('\n');
  const header = newline === -1 ? note : note.slice(0, newline);
  const rest = header.slice(TIP_NOTE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator === -1) return null;
  const kind = rest.slice(0, separator);
  const targetId = rest.slice(separator + 1);
  if (kind !== 'post' && kind !== 'reply') return null;
  try {
    if (bs58.decode(targetId).length !== 32) return null;
  } catch {
    return null;
  }
  return { kind, targetId, message: newline === -1 ? '' : note.slice(newline + 1).trim() };
}

const CASES = new Map([
  ['t1', caseT1Transfer],
  ['t2', caseT2Proof],
  ['t3', caseT3Attribution],
  ['t4', caseT4FromIndex],
  ['t5', caseT5UnsignedBuilder],
]);

let battery;
let handle;

/** One page of `transfer` documents off a token-history index, newest first. */
async function transfers(where, orderFields) {
  return battery.queryDocs(
    'transfer',
    {
      where,
      orderBy: [...orderFields.map((field) => [field, 'asc']), ['$createdAt', 'desc']],
      limit: 100,
    },
    TOKEN_HISTORY_CONTRACT_ID
  );
}

const b58 = (bytes) => bs58.encode(Uint8Array.from(bytes));

async function caseT1Transfer(ctx) {
  console.log('\n== t1: YAPP transfer with a tip note ==');
  const { sdk, tipper, creator, tokenId, amount } = ctx;

  const before = {
    tipper: await battery.yappBalance(tokenId, tipper.ownerId),
    creator: await battery.yappBalance(tokenId, creator.ownerId),
  };
  console.log(`     before: tipper=${before.tipper} creator=${before.creator}`);
  if (before.tipper < amount * 3n) {
    throw new Error(`tipper holds ${before.tipper} YAPP, below the ${amount * 3n} this battery needs`);
  }

  ctx.note = encodeTipNote('post', ctx.postId, 'battery tip');
  // The app caps notes against a hardcoded 2048 (lib/tip-note.ts). Read the cap
  // off the DEPLOYED schema so a lower one is caught here rather than by a
  // rejected broadcast — or, on the wallet path, by nothing at all.
  battery.check(
    't1 the app note cap matches the deployed publicNote maxLength',
    ctx.noteMaxLength === 2048,
    `schema says ${ctx.noteMaxLength}`
  );
  // A note at the full app-side cap must actually be accepted on chain.
  const longNote = encodeTipNote('post', ctx.postId, 'x'.repeat(280));
  battery.check('t1 a max-length message fits the schema cap', longNote.length <= ctx.noteMaxLength, `${longNote.length} chars`);

  const send = async (publicNote) => {
    try {
      await sdk.tokens.transfer({
        dataContractId: ctx.socialId,
        tokenPosition: YAPP_TOKEN_POSITION,
        senderId: tipper.ownerId,
        recipientId: creator.ownerId,
        amount,
        publicNote,
        identityKey: tipper.identityKey,
        signer: tipper.signer,
      });
    } catch (e) {
      // A confirmation-wait 504 does not mean the transfer was refused — the
      // balance readback below decides.
      console.log(`     (transfer reported: ${describeErr(e).slice(0, 140)})`);
    }
    await settle();
  };

  await send(ctx.note);
  // A control transfer with no tip note, to prove the attribution filter in t3
  // actually discriminates rather than accepting everything on the index.
  await send('battery control transfer, not a tip');
  ctx.longNote = longNote;
  await send(longNote);

  const after = {
    tipper: await battery.yappBalance(tokenId, tipper.ownerId),
    creator: await battery.yappBalance(tokenId, creator.ownerId),
  };
  console.log(`     after:  tipper=${after.tipper} creator=${after.creator}`);
  battery.check(
    't1 creator balance grew by exactly 3x the tip',
    after.creator === before.creator + amount * 3n,
    `${before.creator} -> ${after.creator}`
  );
  battery.check(
    't1 tipper balance fell by exactly 3x the tip',
    after.tipper === before.tipper - amount * 3n,
    `${before.tipper} -> ${after.tipper}`
  );
}

async function caseT2Proof(ctx) {
  console.log('\n== t2: the transfer document is on chain, proved ==');
  const { tokenId, tipper, creator, amount } = ctx;

  const rows = await transfers(
    [['tokenId', '==', tokenId], ['toIdentityId', '==', creator.ownerId]],
    ['tokenId', 'toIdentityId']
  );
  console.log(`     ${rows.length} incoming transfer rows for the creator`);
  battery.workingShapes.push({
    label: 'token-history `to` index (tips received)',
    shape: {
      dataContractId: TOKEN_HISTORY_CONTRACT_ID,
      documentTypeName: 'transfer',
      where: [['tokenId', '==', tokenId], ['toIdentityId', '==', creator.ownerId]],
      orderBy: [['tokenId', 'asc'], ['toIdentityId', 'asc'], ['$createdAt', 'desc']],
      limit: 100,
    },
  });

  const mine = rows.find((row) => row.publicNote === ctx.note);
  battery.check('t2 the tip transfer row exists', Boolean(mine), mine ? `id=${normalizeId(mine.$id)}` : 'no row carries our note');
  if (!mine) return;
  ctx.row = mine;

  battery.check('t2 amount is exact', BigInt(mine.amount) === amount, `${mine.amount} vs ${amount}`);
  // queryDocs hands back raw `toObject()` output, so system identifiers are bytes here.
  battery.check('t2 $ownerId is the tipper', normalizeId(mine.$ownerId) === tipper.ownerId, normalizeId(mine.$ownerId));
  battery.check('t2 toIdentityId is the creator', b58(mine.toIdentityId) === creator.ownerId, b58(mine.toIdentityId));
  battery.check('t2 tokenId is YAPP', b58(mine.tokenId) === tokenId, b58(mine.tokenId));
  battery.check('t2 publicNote is verbatim', mine.publicNote === ctx.note, JSON.stringify(mine.publicNote));
  if (ctx.longNote) {
    const long = rows.find((row) => row.publicNote === ctx.longNote);
    battery.check(
      't2 a max-length note round-trips verbatim',
      Boolean(long) && long.publicNote.length === ctx.longNote.length,
      long ? `${long.publicNote.length} chars` : 'the max-length transfer is not on the index'
    );
  }
}

async function caseT3Attribution(ctx) {
  console.log('\n== t3: tip-history-service attribution filter ==');
  const { tokenId, creator, amount } = ctx;

  const rows = await transfers(
    [['tokenId', '==', tokenId], ['toIdentityId', '==', creator.ownerId]],
    ['tokenId', 'toIdentityId']
  );

  // Exactly what lib/services/tip-history-service.ts getTipsForPost does.
  const tips = rows
    .map((row) => ({ row, note: parseTipNote(row.publicNote) }))
    .filter(({ note }) => note?.targetId === ctx.postId)
    .map(({ row, note }) => ({ amount: BigInt(row.amount), from: normalizeId(row.$ownerId), kind: note.kind, message: note.message }));

  console.log(`     ${tips.length} of ${rows.length} rows attribute to post ${ctx.postId}`);
  // Two of this run's three transfers name the post (the tip and the
  // max-length-note one); the control transfer must not.
  battery.check('t3 the filter finds both noted tips', tips.length === 2, `${tips.length} match(es)`);
  const primary = tips.find((tip) => tip.message === 'battery tip');
  battery.check('t3 our tip is among them', Boolean(primary), primary ? '' : 'no row carries the battery message');
  if (!primary) return;
  battery.check('t3 attributed amount is exact', primary.amount === amount, `${primary.amount}`);
  battery.check('t3 attributed kind is post', primary.kind === 'post', primary.kind);

  const untagged = rows.filter((row) => parseTipNote(row.publicNote) === null);
  battery.check(
    't3 the untagged control transfer is NOT attributed',
    untagged.some((row) => row.publicNote === 'battery control transfer, not a tip'),
    `${untagged.length} untagged row(s) on the index`
  );
}

async function caseT4FromIndex(ctx) {
  console.log('\n== t4: the tipper side of the same proof ==');
  const { tokenId, tipper } = ctx;

  const rows = await transfers(
    [['tokenId', '==', tokenId], ['$ownerId', '==', tipper.ownerId]],
    ['tokenId', '$ownerId']
  );
  console.log(`     ${rows.length} outgoing transfer rows for the tipper`);
  battery.workingShapes.push({
    label: 'token-history `from` index (tips sent)',
    shape: {
      dataContractId: TOKEN_HISTORY_CONTRACT_ID,
      documentTypeName: 'transfer',
      where: [['tokenId', '==', tokenId], ['$ownerId', '==', tipper.ownerId]],
      orderBy: [['tokenId', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']],
      limit: 100,
    },
  });
  battery.check(
    't4 the tip is on the from index too',
    rows.some((row) => row.publicNote === ctx.note),
    `${rows.length} row(s)`
  );
}

async function caseT5UnsignedBuilder(ctx) {
  console.log('\n== t5: unsigned wallet-signing transition (no broadcast) ==');
  const { sdk, tipper, creator, tokenId, amount, socialId } = ctx;
  // Self-sufficient so `--only t5` works without a broadcast from t1.
  ctx.note ??= encodeTipNote('post', ctx.postId, 'battery tip');

  // Exactly lib/services/token-transfer-builder.ts.
  const rawNonce = (await sdk.wasm.getIdentityContractNonce(tipper.ownerId, socialId)) ?? 0n;
  const nonce = (BigInt(rawNonce) & SEQUENCE_MASK) + 1n;
  const base = new TokenBaseTransition({
    identityContractNonce: nonce,
    tokenContractPosition: YAPP_TOKEN_POSITION,
    dataContractId: socialId,
    tokenId,
  });
  const transfer = new TokenTransferTransition({
    base,
    recipientId: creator.ownerId,
    amount,
    publicNote: ctx.note,
  });
  const batch = BatchTransition.fromBatchedTransitions(
    [new BatchedTransition(new TokenTransition(transfer))],
    tipper.ownerId,
    0
  );
  const stateTransition = batch.toStateTransition();
  stateTransition.setIdentityContractNonce(nonce);
  const bytes = stateTransition.toBytes();
  console.log(`     built ${bytes.length} unsigned bytes (nonce ${nonce})`);
  battery.check('t5 the builder produced bytes', bytes.length > 0, `${bytes.length} bytes`);

  // The wallet receives these bytes and nothing else, so decode them the same
  // way it must: StateTransition.fromBytes, then back out to the batch.
  const decoded = StateTransition.fromBytes(bytes);
  battery.check('t5 the bytes decode back to a state transition', Boolean(decoded), decoded.actionType ?? '');
  battery.check('t5 decoded owner is the tipper', normalizeId(decoded.ownerId) === tipper.ownerId, normalizeId(decoded.ownerId));
  battery.check('t5 decoded nonce is the one we built with', decoded.identityContractNonce === nonce, `${decoded.identityContractNonce}`);
  battery.check('t5 the transition is unsigned', !decoded.signature || decoded.signature.length === 0, `${decoded.signature?.length ?? 0} sig bytes`);

  const rebuilt = BatchTransition.fromStateTransition(decoded);
  const inner = rebuilt.transitions.map((batched) => batched.toTransition());
  battery.check('t5 the batch holds exactly one transition', inner.length === 1, `${inner.length}`);
  const tokenTransition = inner[0];
  battery.check(
    't5 that transition is a token transfer',
    tokenTransition.transitionType === 'transfer' || tokenTransition.transitionType === 'Transfer',
    `${tokenTransition.transitionType}`
  );
  battery.check('t5 decoded tokenId is YAPP', normalizeId(tokenTransition.tokenId) === tokenId, normalizeId(tokenTransition.tokenId));

  const found = tokenTransition.transition;
  battery.check('t5 decoded recipient is the creator', normalizeId(found.recipientId) === creator.ownerId, normalizeId(found.recipientId));
  battery.check('t5 decoded amount is exact', BigInt(found.amount) === amount, `${found.amount}`);
  battery.check('t5 decoded publicNote is our tip note', found.publicNote === ctx.note, JSON.stringify(found.publicNote));
}

/** Any identifier shape (bytes, base58 string, Identifier) → base58. */
function normalizeId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array || Array.isArray(value)) return b58(value);
  if (typeof value.base58 === 'function') return value.base58();
  if (typeof value.toString === 'function') return value.toString();
  return '';
}

function parseArgs(argv) {
  const args = { tipper: 240, creator: 241, amount: 5n, only: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--tipper': args.tipper = Number(argv[++i]); break;
      case '--creator': args.creator = Number(argv[++i]); break;
      case '--amount': args.amount = BigInt(argv[++i]); break;
      case '--only': args.only = parseOnly(argv[++i], CASES); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  await ensureInitialized();
  const socialId = socialContractId();
  handle = createSdkHandle({ contractIds: [socialId, TOKEN_HISTORY_CONTRACT_ID] });
  const { protocolVersion } = await handle.connect();
  const sdk = handle.sdk;
  console.log(`connected (PV${protocolVersion}); YAPP from ${socialId}; history ${TOKEN_HISTORY_CONTRACT_ID}`);

  battery = createBattery({ handle, contractId: TOKEN_HISTORY_CONTRACT_ID, socialId });
  const tokenId = await battery.readback(() => sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  const [tipper, creator] = await Promise.all([args.tipper, args.creator].map((idx) => battery.personaActor(idx)));
  console.log(`tipper=${tipper.label} creator=${creator.label} token=${tokenId} amount=${args.amount}`);

  // Two transfers of `amount` go out in t1 (the tip and an untagged control).
  await battery.ensureYapp(tokenId, tipper, args.amount * 2n);

  // The tipped "post" only has to be a 32-byte identifier: consensus never
  // resolves it, which is precisely the limit this feature documents. Using a
  // fresh random id keeps the attribution check from colliding with earlier runs.
  const postId = bs58.encode(crypto.getRandomValues(new Uint8Array(32)));

  const historyContract = await battery.readback(() => sdk.contracts.fetch(TOKEN_HISTORY_CONTRACT_ID));
  const contractJson = historyContract.toJSON(protocolVersion);
  const transferSchema = (contractJson.documentSchemas ?? contractJson.documents)?.transfer;
  const noteMaxLength = transferSchema?.properties?.publicNote?.maxLength;
  console.log(`     transfer.publicNote maxLength = ${noteMaxLength}`);

  const ctx = {
    sdk, socialId, tokenId, tipper, creator, amount: args.amount, postId,
    note: null, longNote: null, row: null, noteMaxLength,
  };
  await runCases(battery, CASES, args.only, ctx);

  const failures = battery.report(`post=${postId} note=${JSON.stringify(ctx.note)}`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
