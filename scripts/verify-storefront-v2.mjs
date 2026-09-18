/**
 * Registration-day battery for **storefront contract v2**
 * (`contracts/yappr-storefront-contract-v2.json`, docs/STOREFRONT_V2.md).
 * Runs live against a freshly registered contract on a beta.1+ devnet; there is
 * no default contract id (`--contract` or `STOREFRONT_V2_CONTRACT_ID`).
 *
 * Actors are seed-ledger personas (`.seed-identities.local.json`): a SELLER, a
 * BUYER and a STRANGER. Reviews cost YAPP from the social contract, so the
 * battery buys YAPP for the buyer and the stranger up front (`--yapp`).
 *
 * Cases:
 *   s1  fixtures: seller store + two items; a second seller store belongs to
 *       the stranger for cross-store probes
 *   s2  refersTo on items/zones: ghost storeId rejected (40120), real accepted
 *   s3  orders: buyer order accepted; order naming a GHOST store rejected;
 *       order naming a GHOST seller identity rejected
 *   s4  status updates: seller's update accepted; update carrying the WRONG
 *       sellerId (40127) or WRONG buyerId (40127) rejected; a ghost orderId
 *       rejected (40120); buyerStatusUpdates index serves the buyer's feed
 *   s5  store reviews: buyer review accepted; wrong storeId / sellerId /
 *       buyerId rejected (40127); ghost orderId rejected (40120); a SECOND
 *       review on the same order rejected (40105, unique orderReview); the
 *       stranger's review carrying the buyer's buyerId lands (documented gap:
 *       consensus cannot bind $ownerId) but is one-per-order so it cannot land
 *       once the buyer's exists
 *   s6  item reviews: accepted for both items; item from ANOTHER store
 *       rejected (40127 on the item's storeId agreement); duplicate
 *       (orderId,itemId) rejected (40105)
 *   s7  averages: documents.average per store / seller / item / (store,item)
 *       agree with the client-side arithmetic over the written reviews;
 *       storeRatingDistribution grouped count matches
 *   s8  rankings: top stores by avg and by count, top sellers by avg, top
 *       items globally and pinned to the store — our groups present with exact
 *       values; HAVING rating >= threshold includes/excludes correctly
 *   s9  order counts: buyer/seller/store countable totals; storeOrderCount
 *       ranking carries the store
 *   s10 composite: store page = store + item page + per-item review counts +
 *       per-item average in one proof; orders page = orders + latest status
 *       lookups + review-exists lookups
 *   s11 permanence: store/item/order delete rejected (canBeDeleted:false);
 *       item tombstone by status update accepted
 *   s12 tokens: review create WITHOUT a token payment agreement rejected;
 *       the buyer's YAPP balance dropped by exactly the review costs
 *
 * Run:
 *   NETWORK=devnet node scripts/verify-storefront-v2.mjs --contract <id> \
 *     [--seller 200] [--buyer 201] [--stranger 202] [--yapp 60] [--only s5,s7]
 */
import { IdentitySigner, TokenPaymentInfo, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import {
  DUPLICATE_UNIQUE,
  YAPP_TOKEN_POSITION,
  buildDocument,
  createSdkHandle,
  describeErr,
  ledgerEntry,
  loadLedger,
  randomEntropy,
  readback as readbackWith,
  sleep,
  socialContractId,
  wifFromHex,
} from './seed/seed-lib.mjs';

const SETTLE_MS = 3000;
const POLL_ATTEMPTS = 3;
const REVIEW_COST = { storeReview: 3n, itemReview: 1n };
const DEFAULT_YAPP = 60n;
const MIN_YAPP_PURCHASE = 100n;

const REFERENCE_NOT_FOUND = /40120|referenced .*not found/i;
const PROPERTY_MISMATCH = /40127|does not agree with the referenced document/i;
const DELETE_FORBIDDEN = /can ?not be deleted/i;
const TOKEN_AGREEMENT_MISSING = /token|payment|agree/i;

let failures = 0;
const capturedErrors = [];
const workingShapes = [];

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const settle = () => sleep(SETTLE_MS);
const id32 = (base58) => bs58.decode(base58);

// ---- SDK + actors -----------------------------------------------------------

let handle;
const readback = (fn) => readbackWith(handle, fn);

async function personaActor(sdk, personaIdx) {
  const entry = ledgerEntry(loadLedger(), personaIdx);
  if (!entry) throw new Error(`persona ${personaIdx} is not in the seed ledger`);
  const identity = await readback(() => sdk.identities.fetch(entry.identityId));
  if (!identity) throw new Error(`identity ${entry.identityId} not found on this devnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
  if (!identityKey || !authKey) throw new Error(`persona ${personaIdx} has no CRITICAL auth key`);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));
  return { ownerId: entry.identityId, identityKey, signer, label: `${entry.handle}(${personaIdx})` };
}

async function yappBalance(sdk, tokenId, ownerId) {
  const balances = await readback(() => sdk.tokens.balances([ownerId], tokenId));
  return (balances instanceof Map ? balances.get(ownerId) : undefined) ?? 0n;
}

/** Buys YAPP for an actor up to `target` (direct purchase, CRITICAL key). */
async function ensureYapp(sdk, socialId, tokenId, actor, target) {
  const balance = await yappBalance(sdk, tokenId, actor.ownerId);
  if (balance >= target) return balance;
  const prices = await readback(() => sdk.tokens.directPurchasePrices([tokenId]));
  const info = prices instanceof Map ? prices.get(tokenId) : prices?.[tokenId];
  const price = BigInt(info?.currentPrice ?? 0);
  if (price === 0n) throw new Error(`YAPP ${tokenId} has no direct-purchase price`);
  const amount = MIN_YAPP_PURCHASE > target - balance ? MIN_YAPP_PURCHASE : target - balance;
  console.log(`     buying ${amount} YAPP for ${actor.label} (${amount * price} credits)`);
  try {
    await sdk.tokens.directPurchase({
      dataContractId: socialId,
      tokenPosition: YAPP_TOKEN_POSITION,
      buyerId: actor.ownerId,
      amount,
      maxTotalCost: amount * price,
      identityKey: actor.identityKey,
      signer: actor.signer,
    });
  } catch (e) {
    console.log(`     (purchase reported: ${describeErr(e).slice(0, 140)})`);
  }
  await settle();
  return yappBalance(sdk, tokenId, actor.ownerId);
}

// ---- Writes -----------------------------------------------------------------

async function fetchDocument(sdk, contractId, docType, id) {
  return readback(async () => (await sdk.documents.get(contractId, docType, id)) ?? null);
}

async function attemptWrite({ accepted }, write) {
  let error = null;
  try {
    await write();
  } catch (e) {
    error = describeErr(e);
  }
  for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
    await settle();
    if (await accepted()) return { ok: true, error: null };
  }
  return { ok: false, error: error ?? 'the SDK reported no error, but the write is not on chain' };
}

function paymentInfo(socialId, cost) {
  return cost
    ? {
        tokenPaymentInfo: new TokenPaymentInfo({
          paymentTokenContractId: socialId,
          tokenContractPosition: YAPP_TOKEN_POSITION,
          maximumTokenCost: cost,
        }),
      }
    : {};
}

async function attemptCreate(ctx, who, docType, data, { tokenCost, noPayment } = {}) {
  const { document, id } = buildDocument({
    contractId: ctx.contractId,
    docType,
    ownerId: who.ownerId,
    data,
    entropy: randomEntropy(),
  });
  const outcome = await attemptWrite(
    { accepted: async () => (await fetchDocument(ctx.sdk, ctx.contractId, docType, id)) !== null },
    () =>
      ctx.sdk.documents.create({
        document,
        identityKey: who.identityKey,
        signer: who.signer,
        ...(noPayment ? {} : paymentInfo(ctx.socialId, tokenCost)),
      })
  );
  return { ...outcome, id };
}

async function attemptReplace(ctx, who, docType, id, data, revision) {
  const nextRevision = revision + 1n;
  const { document } = buildDocument({
    contractId: ctx.contractId,
    docType,
    ownerId: who.ownerId,
    data,
    revision: nextRevision,
    id: id32(id),
  });
  return attemptWrite(
    {
      accepted: async () => {
        const d = await fetchDocument(ctx.sdk, ctx.contractId, docType, id);
        return d?.revision !== undefined && d.revision >= nextRevision;
      },
    },
    () => ctx.sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer })
  );
}

async function attemptDelete(ctx, who, docType, id) {
  return attemptWrite(
    { accepted: async () => (await fetchDocument(ctx.sdk, ctx.contractId, docType, id)) === null },
    () =>
      ctx.sdk.documents.delete({
        document: { id, ownerId: who.ownerId, dataContractId: ctx.contractId, documentTypeName: docType },
        identityKey: who.identityKey,
        signer: who.signer,
      })
  );
}

function expectAccepted(label, outcome) {
  check(label, outcome.ok, outcome.ok ? (outcome.id ? `id=${outcome.id}` : '') : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
  return outcome;
}

function expectRejected(label, outcome, pattern) {
  const reason = outcome.error ?? '';
  if (outcome.ok) {
    check(label, false, 'ACCEPTED (BAD)');
    return outcome;
  }
  capturedErrors.push({ label, message: reason });
  const matched = pattern.test(reason);
  check(label, matched, matched ? reason.slice(0, 200) : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 180)}`);
  return outcome;
}

// ---- Reads ------------------------------------------------------------------

async function countBy(ctx, docType, where) {
  return readback(async () => {
    const raw = await ctx.sdk.documents.count({ dataContractId: ctx.contractId, documentTypeName: docType, where });
    const total = raw instanceof Map ? raw.get('') : raw?.[''];
    return total === undefined || total === null ? 0 : Number(total);
  });
}

async function averageBy(ctx, docType, where) {
  return readback(async () => {
    const raw = await ctx.sdk.documents.average(
      { dataContractId: ctx.contractId, documentTypeName: docType, where },
      'rating'
    );
    const entry = raw instanceof Map ? raw.get('') : raw?.[''];
    if (!entry) return { count: 0, sum: 0 };
    return { count: Number(entry.count), sum: Number(entry.sum) };
  });
}

async function ranked(ctx, docType, groupBy, aggregate, extra = {}) {
  const shape = { dataContractId: ctx.contractId, documentTypeName: docType, groupBy, aggregate, limit: 100, ...extra };
  const page = await readback(() => ctx.sdk.documents.ranked(shape));
  return { page, shape };
}

async function ratingDistribution(ctx, storeId) {
  const dist = await readback(() =>
    ctx.sdk.documents.count({
      dataContractId: ctx.contractId, documentTypeName: 'storeReview',
      where: [['storeId', '==', storeId], ['rating', 'in', [1, 2, 3, 4, 5]]], groupBy: ['rating'],
    })
  );
  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const [key, value] of dist.entries()) {
    if (key === '') continue;
    buckets[parseInt(key, 16) - 0x80] = Number(value);
  }
  return buckets;
}

const groupValueOf = (page, key) => page.entries.find((entry) => entry.groupValue === key);

/** Fixed-point avg → number using the result's own scale. */
const avgOf = (page, key) => {
  const entry = groupValueOf(page, key);
  return entry ? Number(entry.value) / Number(page.valueScale) : undefined;
};

const approx = (a, b) => a !== undefined && b !== undefined && Math.abs(a - b) < 1e-6;

// ---- Document shapes --------------------------------------------------------

const storeData = ({ name, status = 'active' }) => ({ name, status, description: 'storefront v2 battery' });
const itemData = ({ storeId, title, status = 'active' }) => ({ storeId, title, status, basePrice: 1000, currency: 'USD' });
const zoneData = ({ storeId, name }) => ({ storeId, name, rateType: 'flat', flatRate: 500, currency: 'USD', priority: 1 });
const orderData = ({ storeId, sellerId, buyerId }) => ({
  storeId,
  sellerId,
  buyerId,
  encryptedPayload: crypto.getRandomValues(new Uint8Array(64)),
  nonce: crypto.getRandomValues(new Uint8Array(24)),
});
const statusData = ({ orderId, sellerId, buyerId, status = 'shipped', message }) => ({
  orderId, sellerId, buyerId, status, ...(message ? { message } : {}),
});
const storeReviewData = ({ storeId, orderId, sellerId, buyerId, rating, title }) => ({
  storeId, orderId, sellerId, buyerId, rating, ...(title ? { title } : {}),
});
const itemReviewData = ({ storeId, itemId, orderId, buyerId, rating }) => ({ storeId, itemId, orderId, buyerId, rating });

// ---- Cases ------------------------------------------------------------------

async function caseS1Fixtures(ctx) {
  console.log('\n--- s1. fixtures: seller store + items, stranger store ---');
  const { seller, stranger } = ctx;
  // Stores are unique per owner: reuse an existing one so re-runs work.
  const existing = async (who) =>
    readback(async () => {
      const result = await ctx.sdk.documents.query({
        dataContractId: ctx.contractId, documentTypeName: 'store',
        where: [['$ownerId', '==', who.ownerId]], limit: 1,
      });
      const first = [...result.values()][0];
      return first ? bs58.encode(Uint8Array.from(first.toObject().$id)) : null;
    });
  ctx.storeId = await existing(seller);
  if (!ctx.storeId) {
    const created = expectAccepted('s1a seller store created', await attemptCreate(ctx, seller, 'store', storeData({ name: 'Ann Store' })));
    ctx.storeId = created.ok ? created.id : null;
  } else {
    check('s1a seller store exists (reused)', true, `id=${ctx.storeId}`);
  }
  ctx.strangerStoreId = await existing(stranger);
  if (!ctx.strangerStoreId) {
    const created = expectAccepted('s1b stranger store created', await attemptCreate(ctx, stranger, 'store', storeData({ name: 'Cy Store' })));
    ctx.strangerStoreId = created.ok ? created.id : null;
  } else {
    check('s1b stranger store exists (reused)', true, `id=${ctx.strangerStoreId}`);
  }
  if (!ctx.storeId || !ctx.strangerStoreId) throw new Error('fixture stores unavailable');

  // The store outlives the run (unique per owner), so store/seller-level
  // aggregates are asserted as DELTAS against this baseline.
  ctx.baseline = {
    store: await averageBy(ctx, 'storeReview', [['storeId', '==', ctx.storeId]]),
    dist: await ratingDistribution(ctx, ctx.storeId),
    orders: await countBy(ctx, 'storeOrder', [['storeId', '==', ctx.storeId]]),
  };
  const item1 = expectAccepted('s1c item one created', await attemptCreate(ctx, seller, 'storeItem', itemData({ storeId: id32(ctx.storeId), title: `Widget ${ctx.run}` })));
  const item2 = expectAccepted('s1d item two created', await attemptCreate(ctx, seller, 'storeItem', itemData({ storeId: id32(ctx.storeId), title: `Gadget ${ctx.run}` })));
  const foreign = expectAccepted('s1e stranger item created', await attemptCreate(ctx, stranger, 'storeItem', itemData({ storeId: id32(ctx.strangerStoreId), title: `Foreign ${ctx.run}` })));
  ctx.item1 = item1.ok ? item1.id : null;
  ctx.item2 = item2.ok ? item2.id : null;
  ctx.foreignItem = foreign.ok ? foreign.id : null;
}

async function caseS2ItemRefs(ctx) {
  console.log('\n--- s2. refersTo on items and shipping zones ---');
  expectRejected(
    's2a item naming a GHOST store is rejected (40120)',
    await attemptCreate(ctx, ctx.seller, 'storeItem', itemData({ storeId: randomEntropy(), title: 'ghost' })),
    REFERENCE_NOT_FOUND
  );
  expectRejected(
    's2b shipping zone naming a GHOST store is rejected (40120)',
    await attemptCreate(ctx, ctx.seller, 'shippingZone', zoneData({ storeId: randomEntropy(), name: `z${ctx.run}` })),
    REFERENCE_NOT_FOUND
  );
  expectAccepted(
    's2c shipping zone on the REAL store is accepted',
    await attemptCreate(ctx, ctx.seller, 'shippingZone', zoneData({ storeId: id32(ctx.storeId), name: `zone${ctx.run}` }))
  );
}

async function caseS3Orders(ctx) {
  console.log('\n--- s3. orders: refersTo store + seller identity ---');
  const { seller, buyer } = ctx;
  const base = { storeId: id32(ctx.storeId), sellerId: id32(seller.ownerId), buyerId: id32(buyer.ownerId) };
  const order = expectAccepted('s3a buyer order on the real store is accepted', await attemptCreate(ctx, buyer, 'storeOrder', orderData(base)));
  ctx.orderId = order.ok ? order.id : null;
  const order2 = expectAccepted('s3b a second buyer order is accepted', await attemptCreate(ctx, buyer, 'storeOrder', orderData(base)));
  ctx.orderId2 = order2.ok ? order2.id : null;
  expectRejected(
    's3c order naming a GHOST store is rejected (40120)',
    await attemptCreate(ctx, buyer, 'storeOrder', orderData({ ...base, storeId: randomEntropy() })),
    REFERENCE_NOT_FOUND
  );
  expectRejected(
    's3d order naming a GHOST seller identity is rejected (40120)',
    await attemptCreate(ctx, buyer, 'storeOrder', orderData({ ...base, sellerId: randomEntropy() })),
    REFERENCE_NOT_FOUND
  );
}

async function caseS4Status(ctx) {
  console.log('\n--- s4. status updates: propertyAgreement on sellerId/buyerId ---');
  if (!ctx.orderId) { check('s4 status', false, 'no order fixture'); return; }
  const { seller, buyer, stranger } = ctx;
  const good = { orderId: id32(ctx.orderId), sellerId: id32(seller.ownerId), buyerId: id32(buyer.ownerId) };
  expectAccepted('s4a seller status update with agreeing ids is accepted', await attemptCreate(ctx, seller, 'orderStatusUpdate', statusData({ ...good, status: 'processing' })));
  expectRejected(
    's4b status update with the WRONG sellerId is rejected (40127)',
    await attemptCreate(ctx, stranger, 'orderStatusUpdate', statusData({ ...good, sellerId: id32(stranger.ownerId) })),
    PROPERTY_MISMATCH
  );
  expectRejected(
    's4c status update with the WRONG buyerId is rejected (40127)',
    await attemptCreate(ctx, seller, 'orderStatusUpdate', statusData({ ...good, buyerId: id32(stranger.ownerId) })),
    PROPERTY_MISMATCH
  );
  expectRejected(
    's4d status update on a GHOST order is rejected (40120)',
    await attemptCreate(ctx, seller, 'orderStatusUpdate', statusData({ ...good, orderId: randomEntropy() })),
    REFERENCE_NOT_FOUND
  );
  // Documented gap: a stranger CAN post an update that carries the right ids.
  // Consensus cannot bind $ownerId; the app must check $ownerId == sellerId.
  const spoof = await attemptCreate(ctx, stranger, 'orderStatusUpdate', statusData({ ...good, status: 'cancelled', message: 'spoof' }));
  check('s4e (documented gap) a stranger update carrying the order\'s own ids LANDS — client must filter on $ownerId == sellerId', spoof.ok, spoof.ok ? `id=${spoof.id}` : (spoof.error ?? '').slice(0, 160));
  const latest = expectAccepted('s4f seller ships the order', await attemptCreate(ctx, seller, 'orderStatusUpdate', statusData({ ...good, status: 'shipped' })));
  ctx.latestStatusId = latest.ok ? latest.id : null;
  await settle();
  const feed = await readback(() =>
    ctx.sdk.documents.query({
      dataContractId: ctx.contractId, documentTypeName: 'orderStatusUpdate',
      where: [['buyerId', '==', buyer.ownerId]], orderBy: [['$createdAt', 'desc']], limit: 10,
    })
  );
  const rows = [...feed.values()].map((doc) => doc.toObject());
  const spoofRows = rows.filter((row) => bs58.encode(Uint8Array.from(row.$ownerId)) !== bs58.encode(Uint8Array.from(row.sellerId)));
  check('s4g buyerStatusUpdates index serves the buyer\'s feed; owner!=sellerId identifies exactly the spoofs', rows.length >= 3 && spoofRows.length >= (spoof.ok ? 1 : 0) && spoofRows.every((row) => bs58.encode(Uint8Array.from(row.$ownerId)) === stranger.ownerId), `rows=${rows.length} spoofs=${spoofRows.length}`);
  workingShapes.push({ label: 'buyer status feed', shape: { documentTypeName: 'orderStatusUpdate', where: [['buyerId', '==', '<buyerId>']], orderBy: [['$createdAt', 'desc']] } });
}

async function caseS5StoreReviews(ctx) {
  console.log('\n--- s5. store reviews: agreement chain, uniqueness, token cost ---');
  if (!ctx.orderId || !ctx.orderId2) { check('s5 reviews', false, 'no order fixtures'); return; }
  const { seller, buyer, stranger } = ctx;
  const good = { storeId: id32(ctx.storeId), orderId: id32(ctx.orderId), sellerId: id32(seller.ownerId), buyerId: id32(buyer.ownerId) };
  const cost = REVIEW_COST.storeReview;
  expectRejected(
    's5a review with the WRONG storeId is rejected (40127)',
    await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, storeId: id32(ctx.strangerStoreId), rating: 5 }), { tokenCost: cost }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    's5b review with the WRONG sellerId is rejected (40127)',
    await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, sellerId: id32(stranger.ownerId), rating: 5 }), { tokenCost: cost }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    's5c review with the WRONG buyerId is rejected (40127)',
    await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, buyerId: id32(stranger.ownerId), rating: 5 }), { tokenCost: cost }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    's5d review on a GHOST order is rejected (40120)',
    await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, orderId: randomEntropy(), rating: 5 }), { tokenCost: cost }),
    REFERENCE_NOT_FOUND
  );
  expectRejected(
    's5e review WITHOUT a token payment agreement is rejected',
    await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, rating: 5 }), { noPayment: true }),
    TOKEN_AGREEMENT_MISSING
  );
  const r1 = expectAccepted('s5f buyer review (4 stars) on order one is accepted', await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, rating: 4, title: 'good' }), { tokenCost: cost }));
  ctx.reviews.push(r1.ok ? 4 : null);
  expectRejected(
    's5g a SECOND review on the same order is rejected (40105 unique orderReview)',
    await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, rating: 1 }), { tokenCost: cost }),
    DUPLICATE_UNIQUE
  );
  expectRejected(
    's5h the stranger reviewing the buyer\'s order (right ids, wrong signer) is rejected — the order\'s single review slot is taken (40105)',
    await attemptCreate(ctx, stranger, 'storeReview', storeReviewData({ ...good, rating: 1 }), { tokenCost: cost }),
    DUPLICATE_UNIQUE
  );
  const r2 = expectAccepted('s5i buyer review (2 stars) on order two is accepted', await attemptCreate(ctx, buyer, 'storeReview', storeReviewData({ ...good, orderId: id32(ctx.orderId2), rating: 2 }), { tokenCost: cost }));
  ctx.reviews.push(r2.ok ? 2 : null);
  ctx.reviews = ctx.reviews.filter((r) => r !== null);
}

async function caseS6ItemReviews(ctx) {
  console.log('\n--- s6. item reviews: item must belong to the store; one per (order,item) ---');
  if (!ctx.orderId || !ctx.item1 || !ctx.item2 || !ctx.foreignItem) { check('s6 item reviews', false, 'fixtures missing'); return; }
  const { buyer } = ctx;
  const cost = REVIEW_COST.itemReview;
  const base = { storeId: id32(ctx.storeId), orderId: id32(ctx.orderId), buyerId: id32(buyer.ownerId) };
  expectRejected(
    's6a item review of an item from ANOTHER store is rejected (40127 on the item\'s storeId agreement)',
    await attemptCreate(ctx, buyer, 'itemReview', itemReviewData({ ...base, itemId: id32(ctx.foreignItem), rating: 5 }), { tokenCost: cost }),
    PROPERTY_MISMATCH
  );
  expectRejected(
    's6b item review of a GHOST item is rejected (40120)',
    await attemptCreate(ctx, buyer, 'itemReview', itemReviewData({ ...base, itemId: randomEntropy(), rating: 5 }), { tokenCost: cost }),
    REFERENCE_NOT_FOUND
  );
  const a = expectAccepted('s6c item one review (5 stars) accepted', await attemptCreate(ctx, buyer, 'itemReview', itemReviewData({ ...base, itemId: id32(ctx.item1), rating: 5 }), { tokenCost: cost }));
  const b = expectAccepted('s6d item two review (3 stars) accepted', await attemptCreate(ctx, buyer, 'itemReview', itemReviewData({ ...base, itemId: id32(ctx.item2), rating: 3 }), { tokenCost: cost }));
  expectRejected(
    's6e duplicate (order,item) review is rejected (40105)',
    await attemptCreate(ctx, buyer, 'itemReview', itemReviewData({ ...base, itemId: id32(ctx.item1), rating: 1 }), { tokenCost: cost }),
    DUPLICATE_UNIQUE
  );
  // Same item, different order → allowed (one review per purchase).
  const c = expectAccepted('s6f item one reviewed again from order TWO (1 star) accepted', await attemptCreate(ctx, buyer, 'itemReview', itemReviewData({ ...base, orderId: id32(ctx.orderId2), itemId: id32(ctx.item1), rating: 1 }), { tokenCost: cost }));
  ctx.itemRatings = { [ctx.item1]: [a.ok ? 5 : null, c.ok ? 1 : null].filter((r) => r !== null), [ctx.item2]: [b.ok ? 3 : null].filter((r) => r !== null) };
}

async function caseS7Averages(ctx) {
  console.log('\n--- s7. proved averages agree with the written ratings ---');
  await settle();
  const expectedStore = ctx.reviews;
  const store = await averageBy(ctx, 'storeReview', [['storeId', '==', ctx.storeId]]);
  const storeDelta = { count: store.count - ctx.baseline.store.count, sum: store.sum - ctx.baseline.store.sum };
  check('s7a store average: count and sum grew by exactly this run\'s reviews', storeDelta.count === expectedStore.length && storeDelta.sum === expectedStore.reduce((s, r) => s + r, 0), `delta=${JSON.stringify(storeDelta)} expected=${JSON.stringify(expectedStore)} total=${JSON.stringify(store)}`);
  const sellerAvg = await averageBy(ctx, 'storeReview', [['sellerId', '==', ctx.seller.ownerId]]);
  check('s7b seller average agrees with the store average (one store per seller)', sellerAvg.count === store.count && sellerAvg.sum === store.sum, `count=${sellerAvg.count} sum=${sellerAvg.sum}`);
  workingShapes.push({ label: 'store average (documents.average, rating)', shape: { documentTypeName: 'storeReview', where: [['storeId', '==', '<storeId>']], property: 'rating' } });

  const buckets = await ratingDistribution(ctx, ctx.storeId);
  const bucketDelta = Object.fromEntries(Object.keys(buckets).map((k) => [k, buckets[k] - ctx.baseline.dist[k]]));
  const expectedBuckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of expectedStore) expectedBuckets[r] += 1;
  check('s7c rating distribution (grouped count over rating in [1..5]) grew by this run\'s reviews', JSON.stringify(bucketDelta) === JSON.stringify(expectedBuckets), `delta=${JSON.stringify(bucketDelta)} expected=${JSON.stringify(expectedBuckets)}`);
  ctx.storeTotals = store;
  workingShapes.push({ label: 'rating distribution (grouped count)', shape: { documentTypeName: 'storeReview', where: [['storeId', '==', '<storeId>'], ['rating', 'in', [1, 2, 3, 4, 5]]], groupBy: ['rating'] } });

  for (const [itemId, ratings] of Object.entries(ctx.itemRatings ?? {})) {
    const item = await averageBy(ctx, 'itemReview', [['itemId', '==', itemId]]);
    check(`s7d item ${itemId.slice(0, 6)} average: count/sum match`, item.count === ratings.length && item.sum === ratings.reduce((s, r) => s + r, 0), `count=${item.count} sum=${item.sum} expected=${JSON.stringify(ratings)}`);
    const pinned = await averageBy(ctx, 'itemReview', [['storeId', '==', ctx.storeId], ['itemId', '==', itemId]]);
    check(`s7e item ${itemId.slice(0, 6)} average pinned to the store agrees`, pinned.count === item.count && pinned.sum === item.sum, `count=${pinned.count} sum=${pinned.sum}`);
  }
}

async function caseS8Rankings(ctx) {
  console.log('\n--- s8. rankings: stores/sellers by average and count, items globally and per store ---');
  const totals = ctx.storeTotals ?? (await averageBy(ctx, 'storeReview', [['storeId', '==', ctx.storeId]]));
  const storeAvg = totals.sum / totals.count;
  const byAvg = await ranked(ctx, 'storeReview', 'storeId', { type: 'avg', property: 'rating' });
  check('s8a top stores by average rating carries our store at its exact average', approx(avgOf(byAvg.page, ctx.storeId), storeAvg), `page=${avgOf(byAvg.page, ctx.storeId)} expected=${storeAvg} entries=${byAvg.page.entries.length}`);
  workingShapes.push({ label: 'top stores by average rating', shape: { ...byAvg.shape, dataContractId: '<contractId>' } });

  const byCount = await ranked(ctx, 'storeReview', 'storeId', { type: 'count' });
  check('s8b most-reviewed stores carries our store at its proved review count', groupValueOf(byCount.page, ctx.storeId)?.value === BigInt(totals.count), `page=${groupValueOf(byCount.page, ctx.storeId)?.value} expected=${totals.count}`);

  const sellers = await ranked(ctx, 'storeReview', 'sellerId', { type: 'avg', property: 'rating' });
  check('s8c top sellers by average carries our seller', approx(avgOf(sellers.page, ctx.seller.ownerId), storeAvg), `page=${avgOf(sellers.page, ctx.seller.ownerId)}`);

  for (const [itemId, ratings] of Object.entries(ctx.itemRatings ?? {})) {
    const avg = ratings.reduce((s, r) => s + r, 0) / ratings.length;
    const global = await ranked(ctx, 'itemReview', 'itemId', { type: 'avg', property: 'rating' });
    check(`s8d global top items carries item ${itemId.slice(0, 6)} at ${avg}`, approx(avgOf(global.page, itemId), avg), `page=${avgOf(global.page, itemId)}`);
    const pinned = await ranked(ctx, 'itemReview', 'itemId', { type: 'avg', property: 'rating' }, { where: [['storeId', '==', ctx.storeId]] });
    check(`s8e store-pinned top items carries item ${itemId.slice(0, 6)} at ${avg}`, approx(avgOf(pinned.page, itemId), avg), `page=${avgOf(pinned.page, itemId)} entries=${pinned.page.entries.length}`);
    if (!workingShapes.some((s) => s.label === 'top items in a store')) {
      workingShapes.push({ label: 'top items in a store', shape: { ...pinned.shape, where: [['storeId', '==', '<storeId>']], dataContractId: '<contractId>' } });
    }
  }
  const mostReviewedItems = await ranked(ctx, 'itemReview', 'itemId', { type: 'count' });
  check('s8f most-reviewed items carries item one at 2', groupValueOf(mostReviewedItems.page, ctx.item1)?.value === 2n, `page=${groupValueOf(mostReviewedItems.page, ctx.item1)?.value}`);

  const having = await readback(() =>
    ctx.sdk.documents.having({
      dataContractId: ctx.contractId, documentTypeName: 'itemReview', groupBy: 'itemId',
      aggregate: { type: 'avg', property: 'rating' }, having: { operator: '>=', value: 3 }, direction: 'desc', limit: 100,
    })
  );
  const havingIds = having.entries.map((entry) => entry.groupValue);
  const item1Avg = ctx.itemRatings[ctx.item1].reduce((s, r) => s + r, 0) / ctx.itemRatings[ctx.item1].length;
  check('s8g HAVING avg >= 3 includes item two (3.0) and excludes item one (avg 3? no: 3.0 → included iff >= 3)', havingIds.includes(ctx.item2) && (item1Avg >= 3) === havingIds.includes(ctx.item1), `ids=${havingIds.length} item1Avg=${item1Avg} item1In=${havingIds.includes(ctx.item1)} item2In=${havingIds.includes(ctx.item2)}`);
  workingShapes.push({ label: 'items rated >= 3 (having)', shape: { documentTypeName: 'itemReview', groupBy: 'itemId', aggregate: { type: 'avg', property: 'rating' }, having: { operator: '>=', value: 3 } } });
}

async function caseS9OrderCounts(ctx) {
  console.log('\n--- s9. order counts + most-ordered stores ---');
  const buyerCount = await countBy(ctx, 'storeOrder', [['$ownerId', '==', ctx.buyer.ownerId]]);
  const sellerCount = await countBy(ctx, 'storeOrder', [['sellerId', '==', ctx.seller.ownerId]]);
  const storeCount = await countBy(ctx, 'storeOrder', [['storeId', '==', ctx.storeId]]);
  check('s9a buyer/seller/store order counts agree; the store count grew by this run\'s 2 orders', buyerCount >= 2 && sellerCount === storeCount && storeCount - ctx.baseline.orders === 2, `buyer=${buyerCount} seller=${sellerCount} store=${storeCount} baseline=${ctx.baseline.orders}`);
  const most = await ranked(ctx, 'storeOrder', 'storeId', { type: 'count' });
  check('s9b most-ordered stores ranking carries our store at the proved count', groupValueOf(most.page, ctx.storeId)?.value === BigInt(storeCount), `page=${groupValueOf(most.page, ctx.storeId)?.value} count=${storeCount}`);
  workingShapes.push({ label: 'most ordered stores', shape: { ...most.shape, dataContractId: '<contractId>' } });
}

async function caseS10Composite(ctx) {
  console.log('\n--- s10. composite: store page and orders page in one proof each ---');
  try {
    const storePage = await readback(() =>
      ctx.sdk.documents.composite({
        dataContractId: ctx.contractId, documentType: 'storeItem',
        where: [['storeId', '==', ctx.storeId]], orderBy: [['$createdAt', 'asc']], limit: 20,
        subQueries: [
          { documentType: 'itemReview', kind: 'counts', bind: { sourceProperty: '$id', field: 'itemId' } },
          { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } },
        ],
      })
    );
    const counts = storePage.subResults[0]?.kind === 'counts' ? storePage.subResults[0].counts : new Map();
    const stores = storePage.subResults[1]?.kind === 'documents' ? storePage.subResults[1].documents : [];
    // Count maps are keyed by hex-encoded index key (the bound identifier's bytes).
    const countFor = (id) => counts.get(id) ?? counts.get(Buffer.from(bs58.decode(id)).toString('hex'));
    check('s10a store page composite: items + per-item review counts + store join', storePage.pageDocuments.length >= 2 && Number(countFor(ctx.item1) ?? 0n) === 2 && Number(countFor(ctx.item2) ?? 0n) === 1 && stores.length === 1, `items=${storePage.pageDocuments.length} c1=${countFor(ctx.item1)} c2=${countFor(ctx.item2)} stores=${stores.length} keys=${[...counts.keys()].slice(0,3).join('|').slice(0,90)}`);
    workingShapes.push({ label: 'store page composite', shape: { documentType: 'storeItem', where: [['storeId', '==', '<storeId>']], subQueries: [{ documentType: 'itemReview', kind: 'counts', bind: { sourceProperty: '$id', field: 'itemId' } }, { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } }] } });
  } catch (e) {
    check('s10a store page composite', false, describeErr(e).slice(0, 220));
  }
  try {
    const orders = await readback(() =>
      ctx.sdk.documents.composite({
        dataContractId: ctx.contractId, documentType: 'storeOrder',
        where: [['$ownerId', '==', ctx.buyer.ownerId]], orderBy: [['$createdAt', 'desc']], limit: 20,
        subQueries: [
          // orderReview is unique per orderId: a value-bounded lookup takes no limit.
          { documentType: 'storeReview', bind: { sourceProperty: '$id', field: 'orderId' } },
          // Lookup on orderAndTime [orderId, $createdAt]: leave it unordered —
          // every component inherits the page's walk direction; an explicit
          // orderBy is refused unless it names the bound field first.
          { documentType: 'orderStatusUpdate', bind: { sourceProperty: '$id', field: 'orderId' }, limit: 100 },
          { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } },
        ],
      })
    );
    const reviews = orders.subResults[0]?.kind === 'documents' ? orders.subResults[0].documents : [];
    const statuses = orders.subResults[1]?.kind === 'documents' ? orders.subResults[1].documents : [];
    check('s10b orders page composite: orders + review-exists + status history + store join', orders.pageDocuments.length >= 2 && reviews.length >= 2 && statuses.length >= 3, `orders=${orders.pageDocuments.length} reviews=${reviews.length} statuses=${statuses.length}`);
    workingShapes.push({ label: 'buyer orders composite', shape: { documentType: 'storeOrder', where: [['$ownerId', '==', '<buyerId>']], subQueries: ['storeReview by orderId', 'orderStatusUpdate by orderId', 'store by $id'] } });
  } catch (e) {
    check('s10b orders page composite', false, describeErr(e).slice(0, 220));
  }
}

async function caseS11Permanence(ctx) {
  console.log('\n--- s11. permanence: store/item/order cannot be deleted; tombstone by status ---');
  expectRejected('s11a store delete is rejected', await attemptDelete(ctx, ctx.seller, 'store', ctx.storeId), DELETE_FORBIDDEN);
  expectRejected('s11b item delete is rejected', await attemptDelete(ctx, ctx.seller, 'storeItem', ctx.item2), DELETE_FORBIDDEN);
  expectRejected('s11c order delete is rejected', await attemptDelete(ctx, ctx.buyer, 'storeOrder', ctx.orderId2), DELETE_FORBIDDEN);
  const current = await fetchDocument(ctx.sdk, ctx.contractId, 'storeItem', ctx.item2);
  const revision = BigInt(current?.revision ?? 1);
  expectAccepted(
    's11d item tombstone (status=deleted) by replace is accepted',
    await attemptReplace(ctx, ctx.seller, 'storeItem', ctx.item2, itemData({ storeId: id32(ctx.storeId), title: `Gadget ${ctx.run}`, status: 'deleted' }), revision)
  );
}

async function caseS12Tokens(ctx) {
  console.log('\n--- s12. YAPP accounting ---');
  const after = await yappBalance(ctx.sdk, ctx.tokenId, ctx.buyer.ownerId);
  const spent = ctx.buyerYappBefore - after;
  const expected = BigInt(ctx.reviews.length) * REVIEW_COST.storeReview + BigInt(Object.values(ctx.itemRatings ?? {}).flat().length) * REVIEW_COST.itemReview;
  check('s12a buyer YAPP dropped by exactly the accepted review costs (rejected writes charge no tokens)', spent === expected, `before=${ctx.buyerYappBefore} after=${after} spent=${spent} expected=${expected}`);
}

const CASES = new Map([
  ['s1', caseS1Fixtures], ['s2', caseS2ItemRefs], ['s3', caseS3Orders], ['s4', caseS4Status],
  ['s5', caseS5StoreReviews], ['s6', caseS6ItemReviews], ['s7', caseS7Averages], ['s8', caseS8Rankings],
  ['s9', caseS9OrderCounts], ['s10', caseS10Composite], ['s11', caseS11Permanence], ['s12', caseS12Tokens],
]);

function parseArgs(argv) {
  const args = { contract: process.env.STOREFRONT_V2_CONTRACT_ID?.trim() || null, seller: 200, buyer: 201, stranger: 202, yapp: DEFAULT_YAPP, only: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--seller': args.seller = Number(argv[++i]); break;
      case '--buyer': args.buyer = Number(argv[++i]); break;
      case '--stranger': args.stranger = Number(argv[++i]); break;
      case '--yapp': args.yapp = BigInt(argv[++i]); break;
      case '--only': args.only = argv[++i].split(',').map((s) => s.trim()); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('Pass --contract <id> or set STOREFRONT_V2_CONTRACT_ID');
  for (const key of args.only ?? []) if (!CASES.has(key)) throw new Error(`unknown case ${key}`);
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  await ensureInitialized();
  const socialId = socialContractId();
  handle = createSdkHandle({ contractIds: [socialId, args.contract] });
  const { protocolVersion } = await handle.connect();
  const sdk = handle.sdk;
  console.log(`connected (PV${protocolVersion}); storefront v2 ${args.contract}; YAPP from ${socialId}`);
  const tokenId = await readback(() => sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  const [seller, buyer, stranger] = await Promise.all([args.seller, args.buyer, args.stranger].map((idx) => personaActor(sdk, idx)));
  console.log(`seller=${seller.label} buyer=${buyer.label} stranger=${stranger.label}`);
  for (const actor of [buyer, stranger]) {
    const balance = await ensureYapp(sdk, socialId, tokenId, actor, args.yapp);
    console.log(`     ${actor.label}: ${balance} YAPP`);
    if (balance < args.yapp) throw new Error(`${actor.label} holds ${balance} YAPP, below the ${args.yapp} the battery needs`);
  }
  const ctx = {
    sdk, contractId: args.contract, socialId, tokenId, seller, buyer, stranger,
    run: Date.now().toString(36), reviews: [], itemRatings: {},
    buyerYappBefore: await yappBalance(sdk, tokenId, buyer.ownerId),
  };
  for (const key of [...CASES.keys()].filter((k) => !args.only || args.only.includes(k))) {
    try {
      await CASES.get(key)(ctx);
    } catch (e) {
      check(`${key} completed`, false, `aborted: ${describeErr(e).slice(0, 220)}`);
    }
  }
  if (capturedErrors.length > 0) {
    console.log('\n--- captured rejection texts (verbatim) ---');
    for (const { label, message } of capturedErrors) console.log(`\n[${label}]\n${message.slice(0, 400)}`);
  }
  if (workingShapes.length > 0) {
    console.log('\n--- working query shapes ---');
    for (const { label, shape } of workingShapes) console.log(`\n# ${label}\n${JSON.stringify(shape)}`);
  }
  console.log(`\nstore=${ctx.storeId} items=${ctx.item1},${ctx.item2} orders=${ctx.orderId},${ctx.orderId2}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
