/**
 * Registration-day battery for **key-exchange contract v3**
 * (`contracts/key-exchange-v3.json`, docs/KEY_EXCHANGE_V3.md). Runs live
 * against a freshly registered contract on a beta.1+ devnet; there is no
 * default contract id (`--contract` or `KEY_EXCHANGE_V3_CONTRACT_ID`).
 *
 * v3 turns `loginKeyResponse` into an **indexOnly** document type: the index
 * entries ARE the rows. The point of the battery is to pin down what that
 * costs the read path, because `lib/services/key-exchange-service.ts`
 * `getResponse()` is the only consumer and the handshake must keep working.
 *
 * Actors: a WRITER persona standing in for the mobile wallet (it is the
 * wallet, not the app, that writes the response after scanning the QR) and,
 * for the cross-owner case, a SECOND writer.
 *
 * Cases:
 *   k1  the wallet's response is accepted, and the app's `getResponse` query
 *       (`where contractId == <base58> and appEphemeralPubKeyHash ==
 *       <base64>`, limit 1 — v2's shape, unchanged) reads back
 *       walletEphemeralPubKey / encryptedPayload byte-identical plus $ownerId,
 *       the wallet identity the app logs in as. The second, differently-shaped
 *       read (`where appEphemeralPubKeyHash == <base64>`) recovers keyIndex
 *       and $createdAt from `byHandshakeMeta` — the two levels that do not fit
 *       under drive's MAX_INDEX_DIFFERENCE = 2 on the first index
 *   k2  a response naming a contractId that is not a registered contract is
 *       rejected (40120) — `contractId` carries `refersTo: {type: contract}`
 *   k3  a SECOND response from the same wallet for the same
 *       (contractId, appEphemeralPubKeyHash) is rejected 40105 by the
 *       structural uniqueness of `oneResponsePerHandshake`, even when every
 *       payload byte differs; a DIFFERENT wallet's response to the same
 *       handshake IS accepted (indexOnly cannot express v2's owner-free
 *       unique index — every index must embed $ownerId)
 *   k4  the TTL'd `byDay` index counts the response in the newest daily
 *       bucket (`timeRange: [{field: '$createdAt', selector: 'newest',
 *       grid: {range: 86400, step: 86400}}]`, `where contractId == X`)
 *   k5  what the TTL'd index CANNOT do: an IN_TIME_RANGE *document* query is
 *       refused on an indexOnly type, and a raw document query is never
 *       routed to a bucketed index. This is why the payload lives in the
 *       non-bucketed read index and does not expire — recorded verbatim
 *   k6  consume-and-delete: the app deletes the response it just read, using
 *       only values the two k1 reads returned, and a fresh handshake on the
 *       same slot is accepted afterwards
 *
 * Run:
 *   NETWORK=devnet node scripts/verify-key-exchange-v3.mjs --contract <id> \
 *     [--writer 250] [--writer2 260] [--only k1,k4]
 *
 * Re-runnable: every case derives a fresh random appEphemeralPubKeyHash, so
 * k3's uniqueness assertions never collide with a previous run's entries.
 */
import { ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  DUPLICATE_UNIQUE,
  REFERENCE_NOT_FOUND,
  createBattery,
  parseOnly,
  runCases,
  settle,
} from './battery-lib.mjs';
import { buildDocument, createSdkHandle, describeErr, randomEntropy, socialContractId } from './seed/seed-lib.mjs';

const DAY = 86400;
const DAY_GRID = { range: DAY, step: DAY };
/** The newest daily bucket of the TTL'd `byDay` index. */
const TODAY = [{ field: '$createdAt', selector: 'newest', grid: DAY_GRID }];

const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
/** Base64 query operand for a plain byte-array property (what the client's `bytesToBase64` emits). */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sameBytes = (a, b) =>
  a !== undefined && b !== undefined && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** A wallet's answer to one login QR: a fresh ECDH key, a fresh sealed payload. */
function responseData(contractIdBase58, hash, keyIndex = 0) {
  return {
    contractId: bs58.decode(contractIdBase58),
    appEphemeralPubKeyHash: hash,
    walletEphemeralPubKey: Uint8Array.from([2, ...randomBytes(32)]),
    encryptedPayload: randomBytes(60),
    keyIndex,
  };
}

/**
 * `keyExchangeService.getResponse()` verbatim: identifier operand base58, plain
 * byte-array operand base64, limit 1, no orderBy (the index is not unique).
 * Routes to `byContractAndEphemeralKey`.
 */
function responseShape(contractId, appContractIdBase58, hash) {
  return {
    dataContractId: contractId,
    documentTypeName: 'loginKeyResponse',
    where: [
      ['contractId', '==', appContractIdBase58],
      ['appEphemeralPubKeyHash', '==', b64(hash)],
    ],
    limit: 1,
  };
}

/** The consume read: the hash alone, routed to `byHandshakeMeta`. */
function metaShape(contractId, hash) {
  return {
    dataContractId: contractId,
    documentTypeName: 'loginKeyResponse',
    where: [['appEphemeralPubKeyHash', '==', b64(hash)]],
    limit: 1,
  };
}

async function getResponse(ctx, hash, appContractId = ctx.appContractId) {
  const docs = await ctx.battery.queryDocs(
    'loginKeyResponse',
    responseShape(ctx.contractId, appContractId, hash)
  );
  return docs[0] ?? null;
}

async function getMeta(ctx, hash) {
  const docs = await ctx.battery.queryDocs('loginKeyResponse', metaShape(ctx.contractId, hash));
  return docs[0] ?? null;
}

/**
 * Writes one response and reports acceptance by reading it back — never from
 * the SDK's throw/no-throw, which on an indexOnly create reports a verified
 * snapshot as an error even when the write landed.
 *
 * The probe pages to 10 rather than to the app's 1: two wallets may answer the
 * same handshake (k3c), and the app's limit-1 read would only ever see whichever
 * entry sorts first.
 */
async function writeResponse(ctx, who, hash, keyIndex = 0) {
  const data = responseData(ctx.appContractId, hash, keyIndex);
  const outcome = await ctx.battery.attemptCreate(who, 'loginKeyResponse', data, {
    accepted: async () => {
      const docs = await ctx.battery.queryDocs('loginKeyResponse', {
        ...responseShape(ctx.contractId, ctx.appContractId, hash), limit: 10,
      });
      return docs.some((doc) => sameBytes(doc.encryptedPayload, data.encryptedPayload));
    },
  });
  return { ...outcome, data };
}

const CASES = new Map();

// ---- k1 the handshake read ---------------------------------------------------

CASES.set('k1', async (ctx) => {
  console.log('\n--- k1. wallet response accepted; the two reads recover the whole tuple ---');
  const { battery } = ctx;
  const written = await writeResponse(ctx, ctx.writer, ctx.hash1, 7);
  if (!battery.expectAccepted("k1a wallet response accepted (readback: the app's own getResponse query)", written).ok) return;
  ctx.response1 = written.data;

  const doc = await getResponse(ctx, ctx.hash1);
  battery.check(
    'k1b getResponse (byContractAndEphemeralKey, v2 query shape) returns walletEphemeralPubKey + encryptedPayload byte-identical',
    doc !== null
      && sameBytes(doc.walletEphemeralPubKey, written.data.walletEphemeralPubKey)
      && sameBytes(doc.encryptedPayload, written.data.encryptedPayload),
    doc ? `payload=${b64(doc.encryptedPayload ?? []).slice(0, 12)}…` : 'no document'
  );
  battery.check(
    'k1c the synthesized document carries $ownerId — the wallet identity the app logs in as',
    doc !== null && battery.b58(doc.$ownerId ?? []) === ctx.writer.ownerId,
    doc ? `ownerId=${battery.b58(doc.$ownerId ?? [])}` : 'no document'
  );
  battery.workingShapes.push({
    label: 'getResponse (byContractAndEphemeralKey; v2 shape, difference 2)',
    shape: {
      dataContractId: '<contractId>',
      documentTypeName: 'loginKeyResponse',
      where: [['contractId', '==', '<base58>'], ['appEphemeralPubKeyHash', '==', '<base64>']],
      limit: 1,
    },
  });

  const meta = await getMeta(ctx, ctx.hash1);
  battery.check(
    'k1d the consume read (hash alone → byHandshakeMeta) recovers keyIndex and $createdAt, which do not fit under the first index',
    meta !== null && Number(meta.keyIndex) === 7 && (meta.$createdAt ?? null) !== null,
    meta ? `keyIndex=${meta.keyIndex} createdAt=${meta.$createdAt}` : 'no document'
  );
  battery.workingShapes.push({
    label: 'consume read (byHandshakeMeta; hash alone, difference 2)',
    shape: {
      dataContractId: '<contractId>',
      documentTypeName: 'loginKeyResponse',
      where: [['appEphemeralPubKeyHash', '==', '<base64>']],
      limit: 1,
    },
  });
});

// ---- k2 the refersTo on contractId -------------------------------------------

CASES.set('k2', async (ctx) => {
  console.log('\n--- k2. contractId refersTo a CONTRACT: a ghost application id is refused ---');
  const ghost = bs58.encode(randomBytes(32));
  const hash = randomBytes(20);
  const data = responseData(ghost, hash);
  ctx.battery.expectRejected(
    'k2a response naming a contractId that is not a registered contract is rejected (40120)',
    await ctx.battery.attemptCreate(ctx.writer, 'loginKeyResponse', data, {
      accepted: async () => (await getResponse(ctx, hash, ghost)) !== null,
    }),
    REFERENCE_NOT_FOUND
  );
});

// ---- k3 structural uniqueness ------------------------------------------------

CASES.set('k3', async (ctx) => {
  console.log('\n--- k3. one response per (contractId, appEphemeralPubKeyHash, wallet identity) ---');
  const { battery } = ctx;
  const hash = randomBytes(20);
  if (!battery.expectAccepted('k3a first response on a fresh handshake accepted', await writeResponse(ctx, ctx.writer, hash)).ok) return;

  // Every payload byte differs, so only `oneResponsePerHandshake`
  // ([$ownerId, appEphemeralPubKeyHash] terminal contractId) can refuse this:
  // `byContractAndEphemeralKey` carries the payload and would see a new tuple.
  const second = responseData(ctx.appContractId, hash, 99);
  battery.expectRejected(
    'k3b SECOND response from the same wallet on the same handshake is rejected (40105), even with a different payload',
    await battery.attemptCreate(ctx.writer, 'loginKeyResponse', second, {
      accepted: async () => {
        const docs = await battery.queryDocs('loginKeyResponse', {
          ...responseShape(ctx.contractId, ctx.appContractId, hash), limit: 10,
        });
        return docs.some((doc) => sameBytes(doc.encryptedPayload, second.encryptedPayload));
      },
    }),
    DUPLICATE_UNIQUE
  );

  // Documented regression from v2: that contract's unique index had no
  // $ownerId, so the FIRST wallet to answer a QR owned it globally. Every
  // indexOnly index must embed $ownerId, so per-owner is the strongest
  // uniqueness v3 can express.
  const rival = await writeResponse(ctx, ctx.writer2, hash);
  battery.check(
    "k3c a DIFFERENT wallet CAN answer the same handshake (indexOnly cannot express v2's owner-free unique index)",
    rival.ok,
    rival.ok ? 'accepted, as expected' : `rejected: ${(rival.error ?? '').slice(0, 160)}`
  );
});

// ---- k4 the TTL'd aggregate --------------------------------------------------

CASES.set('k4', async (ctx) => {
  console.log("\n--- k4. byDay (timeRange + ttl): today's handshake count per application ---");
  const { battery } = ctx;
  if (!ctx.response1 && !(await writeResponse(ctx, ctx.writer, ctx.hash1)).ok) {
    battery.check("k4 today's count", false, 'no response written');
    return;
  }
  await settle();
  const shape = {
    dataContractId: ctx.contractId,
    documentTypeName: 'loginKeyResponse',
    where: [['contractId', '==', ctx.appContractId]],
    timeRange: TODAY,
  };
  const raw = await battery.readback(() => ctx.sdk.documents.count(shape));
  const total = Number((raw instanceof Map ? raw.get('') : raw?.['']) ?? 0);
  battery.check(
    "k4a countable byDay, newest daily bucket, contractId pinned: the run's responses are counted",
    total >= 1,
    `count=${total}`
  );
  battery.workingShapes.push({
    label: "today's handshake responses (byDay, newest, TTL'd)",
    shape: { ...shape, dataContractId: '<contractId>', where: [['contractId', '==', '<appContractId>']] },
  });
});

// ---- k5 what the TTL'd index cannot serve ------------------------------------

CASES.set('k5', async (ctx) => {
  console.log("\n--- k5. the TTL'd index serves counts only: no document reads, ever ---");
  const { battery } = ctx;

  // (1) An explicit IN_TIME_RANGE document fetch.
  let error = null;
  try {
    await ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'loginKeyResponse',
      where: [['contractId', '==', ctx.appContractId]],
      timeRange: TODAY,
      limit: 10,
    });
  } catch (e) {
    error = describeErr(e);
  }
  battery.check(
    'k5a IN_TIME_RANGE document query on the indexOnly type is refused (bucket-start granularity cannot synthesize a document)',
    error !== null,
    error ? error.slice(0, 220) : 'ACCEPTED (BAD) — the finding in docs/KEY_EXCHANGE_V3.md would be wrong'
  );
  if (error) battery.workingShapes.push({ label: "REFUSED: IN_TIME_RANGE document read on an indexOnly type", shape: { reason: error.slice(0, 200) } });

  // (2) The plain read, which must therefore route to the NON-bucketed index —
  //     proving the payload cannot live in the TTL'd index alone.
  if (!ctx.response1) {
    const seeded = await writeResponse(ctx, ctx.writer, ctx.hash1);
    if (seeded.ok) ctx.response1 = seeded.data;
  }
  const doc = ctx.response1 ? await getResponse(ctx, ctx.hash1) : null;
  battery.check(
    'k5b the same raw where-clause (no timeRange) is served by the non-bucketed byContractAndEphemeralKey and returns the payload',
    doc !== null && sameBytes(doc.encryptedPayload, ctx.response1?.encryptedPayload),
    doc ? 'payload recovered from the permanent index' : 'no document (k1 must run first)'
  );
});

// ---- k6 consume and delete ---------------------------------------------------

CASES.set('k6', async (ctx) => {
  console.log('\n--- k6. consume-and-delete: the app deletes the response it just read ---');
  const { battery } = ctx;
  const hash = randomBytes(20);
  const written = await writeResponse(ctx, ctx.writer, hash, 3);
  if (!battery.expectAccepted('k6a response to delete accepted', written).ok) return;

  // NOTHING from the create is reused: the tuple comes back from the app's own
  // two reads, which is all a consuming client holds.
  const doc = await getResponse(ctx, hash);
  const meta = await getMeta(ctx, hash);
  if (!doc || !meta) {
    battery.check('k6b delete-by-values', false, `reads returned response=${!!doc} meta=${!!meta}`);
    return;
  }
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType: 'loginKeyResponse',
    ownerId: ctx.writer.ownerId,
    data: {
      contractId: bs58.decode(ctx.appContractId),
      appEphemeralPubKeyHash: Uint8Array.from(doc.appEphemeralPubKeyHash),
      walletEphemeralPubKey: Uint8Array.from(doc.walletEphemeralPubKey),
      encryptedPayload: Uint8Array.from(doc.encryptedPayload),
      keyIndex: Number(meta.keyIndex),
    },
    entropy: randomEntropy(),
    createdAt: BigInt(meta.$createdAt),
  });
  const deleted = await battery.attemptDeleteByValues(
    ctx.writer,
    document,
    async () => (await getResponse(ctx, hash)) === null
  );
  battery.expectAccepted('k6b delete-by-values with the tuple the two reads returned is accepted (the app can clean up after login)', deleted);
  if (!deleted.ok) return;

  const reuse = await writeResponse(ctx, ctx.writer, hash, 4);
  battery.expectAccepted('k6c a fresh response on the same handshake slot is accepted after the delete (structural uniqueness cleared)', reuse);
});

// ---- entrypoint --------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    contract: process.env.KEY_EXCHANGE_V3_CONTRACT_ID?.trim() || null,
    writer: 250, writer2: 260, only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--writer': args.writer = Number(argv[++i]); break;
      case '--writer2': args.writer2 = Number(argv[++i]); break;
      case '--only': args.only = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('Pass --contract <id> or set KEY_EXCHANGE_V3_CONTRACT_ID');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const only = parseOnly(args.only, CASES);
  await ensureInitialized();
  const socialId = socialContractId();
  const handle = createSdkHandle({ contractIds: [socialId, args.contract] });
  const { protocolVersion } = await handle.connect();
  console.log(`connected (PV${protocolVersion}); key exchange v3 ${args.contract}`);

  const battery = createBattery({ handle, contractId: args.contract, socialId });
  const [writer, writer2] = await Promise.all(
    [args.writer, args.writer2].map((idx) => battery.personaActor(idx))
  );
  console.log(`writer=${writer.label} writer2=${writer2.label}`);

  const ctx = {
    battery, sdk: battery.sdk, contractId: args.contract,
    // The application the wallet is logging in to — any registered contract;
    // the social contract is the one a devnet always has.
    appContractId: socialId,
    writer, writer2,
    hash1: randomBytes(20),
    response1: null,
  };
  console.log(`app contract=${ctx.appContractId} handshake=${b64(ctx.hash1)}`);

  await runCases(battery, CASES, only, ctx);
  const failures = battery.report();
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
