/**
 * Registration-day battery for the **storefront contract**
 * (`contracts/yappr-storefront-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run
 * live on a beta.1+ devnet. Actors are seed-ledger personas: a SELLER, a BUYER and
 * a STRANGER. The committed contract is storefront v6, which charges action fees
 * (credits) instead of YAPP, so the actors need credits only.
 *
 *   NETWORK=devnet node scripts/verify-storefront.mjs --contract <id> \
 *     [--seller 200] [--buyer 201] [--stranger 202] [--moderator maker|personal|<persona>] [--only s5,s7]
 *
 * `--moderator` is the contract's owner or one it appointed at publish time:
 * `maker` (the default; it publishes and is appointed), `personal` (ledger
 * persona 900) or any seed-ledger persona index; v3 (beta.3) is a moderated cut, so s14/s15
 * ban the stranger and take reviews down. v4 (beta.4) keeps a warning list
 * (s17), stores `tags`/`imageUrls` as typed string arrays (s18) and refuses a
 * seller reviewing an order on their own store (s19, distinctFrom). The beta.5
 * re-cut adds `propertyConstraints` (s20: a price or a flat rate names its
 * currency; a tiered zone carries its tiers; each breach is refused 10422).
 * The beta.7 cut (storefront topology v5) fixes QA D-25: an order copies its
 * store's `status` into `storeStatus` through the storeId `where` (40127 on a
 * stale copy) and `storeIsOpen` refuses any status but active (10422): s21.
 * Storefront topology v6 adds digital products (docs/DIGITAL_PRODUCTS.md):
 * `storeItem.fulfillment`, the seller-only `itemDeliverable` kit and the
 * seller-written `orderDelivery`: s22. v6 is also the mainnet re-cut
 * (docs/NON_SOCIAL_CONTRACTS.md): no YAPP; store, item and review creates
 * carry an action-fee agreement (s5e, s6b2, s12); stores and items are
 * moderator-deletable (s24); an order's seller is never its buyer (s19); status
 * updates and deliveries store no buyerId (the buyer's feeds are derived
 * `orderId.$ownerId` indexes: s4g, s22q); a store files under a category slug,
 * with proved "newest" and "top categories" reads (s23). The cases for the
 * dropped indexes (per-seller averages and order counts, global item
 * rankings, most-reviewed stores) are gone with them.
 *   node scripts/verify-storefront.mjs --self-test   # offline: contract declares what the cases assert
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { DocumentActionFeeAgreement } from '@dashevo/evo-sdk';
import {
  DELETE_FORBIDDEN, DUPLICATE_UNIQUE, IMMUTABLE_CHANGED, PROPERTY_MISMATCH, REFERENCE_NOT_FOUND,
  MODERATOR_FLAG, decodeIntGroupKey, id32, reportSelfTest, runBattery, settle,
} from './battery-lib.mjs';
import { REPO_ROOT, actionFeeAgreementOptions, actionFeeFor, buildDocument, describeErr, feeAgreementFor, feeMultiplierPermille, randomEntropy } from './seed/seed-lib.mjs';
import { ARRAY_OUT_OF_BOUNDS, NOT_A_LIST, NOT_DISTINCT, caseBan, caseModeratorDelete, caseWarn, selfTestModerated } from './battery-moderation.mjs';
import { AGREEMENT_MISMATCH, AGREEMENT_NOT_SET } from './social-battery-lib.mjs';
import { DECLARED_RULES, constraintViolation, refusedCreates } from './property-constraint-cases.mjs';

const CONTRACT_FILE = 'yappr-storefront-contract.json';
const CONTRACT = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', CONTRACT_FILE), 'utf8'));
const SCHEMAS = CONTRACT.documentSchemas;
const RATINGS = [1, 2, 3, 4, 5];
/** The category every battery store files under (a v6 slug), so s23 knows what to look for. */
const CATEGORY = 'battery-goods';
/** A JSON-schema refusal (10101): a pattern, an enum or an unknown property. */
const SCHEMA_REFUSED = /\bcode"?\s*[=:]\s*10101\b|jsonschemaerror:/i;
// A writer gate (a `where` entry valued `$ownerId`: the signer on the REFERRING
// side) fails as the same 40127 a value pair does.
const WRITER_GATE = PROPERTY_MISMATCH;
const STALE_REVISION = /\b40106\b|has invalid revision/i;
/** A replace of a documentsMutable:false type (the advanced-structure refusal), or its revision check (40106) if that runs first. */
const NOT_MUTABLE = /is not mutable and can not be replaced|\bcode"?\s*[=:]\s*(1040[0-9]|40106)\b|invaliddocumentrevision/i;

// ---- Document shapes --------------------------------------------------------

const storeData = ({ name, status = 'active', category = CATEGORY }) => ({ name, status, category, description: 'storefront battery' });
const itemData = ({ storeId, title, status = 'active', tags, imageUrls }) => ({ storeId, title, status, basePrice: 1000, currency: 'USD', ...(tags ? { tags } : {}), ...(imageUrls ? { imageUrls } : {}) });
const zoneData = ({ storeId, name }) => ({ storeId, name, rateType: 'flat', flatRate: 500, currency: 'USD', priority: 1 });
// No buyerId anywhere: the buyer is the order's $ownerId, and the documents filed
// under it index `orderId.$ownerId` (v6), derived through the order. `storeStatus`
// is the store's status, which v5 requires (QA D-25) and only an active store satisfies.
const orderData = ({ storeId, sellerId, storeStatus = 'active' }) => ({ storeId, sellerId, storeStatus, encryptedPayload: crypto.getRandomValues(new Uint8Array(64)), nonce: crypto.getRandomValues(new Uint8Array(24)) });
const statusData = ({ orderId, status = 'shipped', message }) => ({ orderId, status, ...(message ? { message } : {}) });
const storeReviewData = ({ storeId, orderId, sellerId, rating, title }) => ({ storeId, orderId, sellerId, rating, ...(title ? { title } : {}) });
const itemReviewData = ({ storeId, itemId, orderId, rating }) => ({ storeId, itemId, orderId, rating });
// Digital payloads are opaque ciphertext to consensus, so random bytes stand in.
const deliverableData = ({ itemId }) => ({ itemId, encryptedPayload: crypto.getRandomValues(new Uint8Array(96)) });
const deliveryData = ({ orderId }) => ({ orderId, encryptedPayload: crypto.getRandomValues(new Uint8Array(64)), nonce: crypto.getRandomValues(new Uint8Array(24)) });
/** The buyer's feed of `docType` (v6 `buyerFeed`/`buyerDeliveries`): the derived property pinned with `==`. */
const buyerFeedQuery = (buyerId) => ({ where: [['orderId.$ownerId', '==', buyerId]], orderBy: [['orderId.$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20 });
/** A kit's stored ciphertext, or null when it does not read back. */
async function kitBytes(battery, id) {
  const stored = (await battery.fetchDocument('itemDeliverable', id))?.toObject?.().encryptedPayload;
  return stored ? Buffer.from(stored) : null;
}
/** The two doctypes that live UNDER a store, addressed by name for the s2 tables. */
const UNDER_STORE = { storeItem: (storeId, tag) => itemData({ storeId, title: tag }), shippingZone: (storeId, tag) => zoneData({ storeId, name: tag }) };

/** Star histogram for a store: grouped count over `rating in [1..5]`, 0x80-offset keys. */
async function ratingDistribution(battery, storeId) {
  const grouped = await battery.groupedCount('storeReview', [['storeId', '==', storeId], ['rating', 'in', RATINGS]], ['rating'], decodeIntGroupKey);
  return Object.fromEntries(RATINGS.map((rating) => [rating, grouped.get(rating) ?? 0]));
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

// ---- Cases ------------------------------------------------------------------

async function caseS1Fixtures(ctx) {
  const { battery, seller, stranger, run } = ctx;
  console.log('\n--- s1. fixtures: seller store + items, stranger store ---');
  // Stores are unique per owner: reuse an existing one so re-runs work.
  const existing = async (who) => { const [first] = await battery.queryDocs('store', { where: [['$ownerId', '==', who.ownerId]], limit: 1 }); return first ? battery.b58(first.$id) : null; };
  for (const [key, label, who, name] of [['storeId', 's1a seller store', seller, 'Ann Store'], ['strangerStoreId', 's1b stranger store', stranger, 'Cy Store']]) {
    ctx[key] = await existing(who);
    if (ctx[key]) { battery.check(`${label} exists (reused)`, true, `id=${ctx[key]}`); continue; }
    const created = await battery.probeCreate(`${label} created`, null, who, 'store', storeData({ name }));
    ctx[key] = created.ok ? created.id : null;
  }
  if (!ctx.storeId || !ctx.strangerStoreId) throw new Error('fixture stores unavailable');
  // The store outlives the run, so store/seller aggregates are asserted as DELTAS.
  ctx.baseline = {
    store: await battery.averageBy('storeReview', 'rating', [['storeId', '==', ctx.storeId]]),
    dist: await ratingDistribution(battery, ctx.storeId),
    orders: await battery.countBy('storeOrder', [['storeId', '==', ctx.storeId]]),
  };
  const items = [];
  for (const [label, who, storeId, title] of [['s1c item one', seller, ctx.storeId, 'Widget'], ['s1d item two', seller, ctx.storeId, 'Gadget'], ['s1e stranger item', stranger, ctx.strangerStoreId, 'Foreign']]) {
    const created = await battery.probeCreate(`${label} created`, null, who, 'storeItem', itemData({ storeId: id32(storeId), title: `${title} ${run}` }));
    items.push(created.ok ? created.id : null);
  }
  [ctx.item1, ctx.item2, ctx.foreignItem] = items;
}

async function caseS2ItemRefs(ctx) {
  const { battery, seller, stranger, run } = ctx;
  console.log('\n--- s2. refersTo + writer gate on items and shipping zones ---');
  for (const [label, docType] of [['s2a item', 'storeItem'], ['s2b shipping zone', 'shippingZone']]) {
    await battery.probeCreate(`${label} naming a GHOST store is rejected (40120)`, REFERENCE_NOT_FOUND, seller, docType, UNDER_STORE[docType](randomEntropy(), `ghost${run}`));
  }
  const zone = await battery.probeCreate('s2c shipping zone on the REAL store is accepted', null, seller, 'shippingZone', zoneData({ storeId: id32(ctx.storeId), name: `zone${run}` }));
  ctx.zoneId = zone.ok ? zone.id : null;
  // Writer gate: `storeId` agrees {$ownerId: $ownerId} against the store, so only
  // its owner may list under it. Before beta.2 both landed and only the UI hid them.
  for (const [label, docType] of [["s2d a STRANGER listing an item under the seller's store", 'storeItem'], ["s2e a STRANGER adding a shipping zone to the seller's store", 'shippingZone']]) {
    await battery.probeCreate(`${label} is rejected (writer gate, 40127)`, WRITER_GATE, stranger, docType, UNDER_STORE[docType](id32(ctx.storeId), `intruder${run}`));
  }
}

async function caseS3Orders(ctx) {
  const { battery, seller, buyer, stranger } = ctx;
  console.log('\n--- s3. orders: refersTo store, sellerId agreed against the store owner ---');
  const base = { storeId: id32(ctx.storeId), sellerId: id32(seller.ownerId) };
  const order = (label, expect, data) => battery.probeCreate(label, expect, buyer, 'storeOrder', orderData({ ...base, ...data }));
  const [first, second] = [await order('s3a buyer order on the real store is accepted', null, {}), await order('s3b a second buyer order is accepted', null, {})];
  ctx.orderId = first.ok ? first.id : null;
  ctx.orderId2 = second.ok ? second.id : null;
  await order('s3c order naming a GHOST store is rejected (40120)', REFERENCE_NOT_FOUND, { storeId: randomEntropy() });
  // sellerId is agreed against the store's own $ownerId, so a wrong seller is a
  // 40127 — stronger than the old "the identity exists" check a stranger passed.
  await order('s3d order claiming the WRONG sellerId is rejected (40127)', PROPERTY_MISMATCH, { sellerId: id32(stranger.ownerId) });
}

async function caseS4Status(ctx) {
  const { battery, seller, buyer, stranger } = ctx;
  console.log('\n--- s4. status updates: writer gate on the seller, the buyer feed derived through the order ---');
  if (!ctx.orderId) { battery.check('s4 status', false, 'no order fixture'); return; }
  const good = { orderId: id32(ctx.orderId) };
  const update = (label, expect, who, data) => battery.probeCreate(label, expect, who, 'orderStatusUpdate', statusData({ ...good, ...data }));
  await update('s4a seller status update is accepted', null, seller, { status: 'processing' });
  // v6 stores no buyerId (the feed is derived), so a copy is an unknown property.
  // buyerId is added AFTER the shape helper (which only knows v6's properties), so the probe really sends it.
  await battery.probeCreate('s4b a status update still carrying buyerId is refused (10101: v6 derives it)', SCHEMA_REFUSED, seller, 'orderStatusUpdate',
    { ...statusData(good), buyerId: id32(buyer.ownerId) });
  await update('s4c status update on a GHOST order is rejected (40120)', REFERENCE_NOT_FOUND, seller, { orderId: randomEntropy() });
  // THE GAP THAT CLOSED: a stranger could post an update carrying the order's own
  // ids and only the client hid it. `{$ownerId: sellerId}` refuses it at write time.
  await update('s4d a STRANGER posting an update on the order is rejected (writer gate, 40127)', WRITER_GATE, stranger, { status: 'cancelled', message: 'spoof' });
  await update('s4e even the BUYER cannot post a status update on their own order (writer gate, 40127)', WRITER_GATE, buyer, { status: 'cancelled' });
  await update('s4f seller ships the order', null, seller, { status: 'shipped' });
  await settle();
  const rows = await battery.queryDocs('orderStatusUpdate', buyerFeedQuery(buyer.ownerId));
  // The buyer persona may hold orders with other sellers too (the storefront
  // seeder buys from four), so the invariant is per ORDER: every row was
  // written by the seller that order names — never "by this run's seller".
  const sellerOf = new Map();
  const foreign = [];
  for (const row of rows) {
    const orderId = battery.b58(row.orderId);
    if (!sellerOf.has(orderId)) {
      const order = await battery.fetchDocument('storeOrder', orderId);
      sellerOf.set(orderId, order ? battery.b58(order.toObject().sellerId) : null);
    }
    if (battery.b58(row.$ownerId) !== sellerOf.get(orderId)) foreign.push(row);
  }
  const mine = rows.filter((row) => battery.b58(row.orderId) === ctx.orderId);
  battery.check("s4g buyerFeed (orderId.$ownerId) serves the buyer's feed, and EVERY row on it was written by its order's seller", mine.length >= 2 && foreign.length === 0, `rows=${rows.length} thisOrder=${mine.length} foreign=${foreign.length}`);
  battery.workingShapes.push({ label: 'buyer status feed', shape: { documentTypeName: 'orderStatusUpdate', ...buyerFeedQuery('<buyerId>') } });
  if (mine[0]) {
    await battery.probeDelete('s4h a status update cannot be deleted (it is the order\'s history)', DELETE_FORBIDDEN, seller, 'orderStatusUpdate', battery.b58(mine[0].$id));
  }
}

async function caseS5StoreReviews(ctx) {
  const { battery, seller, buyer, stranger } = ctx;
  console.log('\n--- s5. store reviews: agreement chain, uniqueness, action fee ---');
  if (!ctx.orderId || !ctx.orderId2) { battery.check('s5 reviews', false, 'no order fixtures'); return; }
  const good = { storeId: id32(ctx.storeId), orderId: id32(ctx.orderId), sellerId: id32(seller.ownerId), rating: 5 };
  const review = (label, expect, who, data, options) => battery.probeCreate(label, expect, who, 'storeReview', storeReviewData({ ...good, ...data }), options);
  await review('s5a review with the WRONG storeId is rejected (40127)', PROPERTY_MISMATCH, buyer, { storeId: id32(ctx.strangerStoreId) });
  await review('s5b review with the WRONG sellerId is rejected (40127)', PROPERTY_MISMATCH, buyer, { sellerId: id32(stranger.ownerId) });
  // THE GAP THAT CLOSED: a stranger could review someone else's order if it carried
  // the right ids. The gate refuses it outright, BEFORE the buyer's own review exists.
  await review("s5c a STRANGER reviewing the buyer's order is rejected (writer gate, 40127)", WRITER_GATE, stranger, { rating: 1 });
  await review('s5d review on a GHOST order is rejected (40120)', REFERENCE_NOT_FOUND, buyer, { orderId: randomEntropy() });
  await review('s5e review WITHOUT the action fee agreement is rejected (40132)', AGREEMENT_NOT_SET, buyer, {}, { noAgreement: true });
  const r1 = await review('s5f buyer review (4 stars) on order one is accepted', null, buyer, { rating: 4, title: 'good' });
  await review('s5g a SECOND review on the same order is rejected (40105 unique orderReview)', DUPLICATE_UNIQUE, buyer, { rating: 1 });
  const r2 = await review('s5i buyer review (2 stars) on order two is accepted', null, buyer, { orderId: id32(ctx.orderId2), rating: 2 });
  ctx.reviews = [r1.ok ? 4 : null, r2.ok ? 2 : null].filter((rating) => rating !== null);
}

async function caseS6ItemReviews(ctx) {
  const { battery, buyer } = ctx;
  console.log('\n--- s6. item reviews: item must belong to the store; one per (order,item) ---');
  if (!ctx.orderId || !ctx.item1 || !ctx.item2 || !ctx.foreignItem) { battery.check('s6 item reviews', false, 'fixtures missing'); return; }
  const base = { storeId: id32(ctx.storeId), orderId: id32(ctx.orderId) };
  const review = (label, expect, data) => battery.probeCreate(label, expect, buyer, 'itemReview', itemReviewData({ ...base, ...data }));
  await review("s6a item review of an item from ANOTHER store is rejected (40127 on the item's storeId agreement)", PROPERTY_MISMATCH, { itemId: id32(ctx.foreignItem), rating: 5 });
  await review('s6b item review of a GHOST item is rejected (40120)', REFERENCE_NOT_FOUND, { itemId: randomEntropy(), rating: 5 });
  await battery.probeCreate('s6b2 an item review WITHOUT the action fee agreement is rejected (40132)', AGREEMENT_NOT_SET, buyer, 'itemReview', itemReviewData({ ...base, itemId: id32(ctx.item1), rating: 5 }), { noAgreement: true });
  const one = await review('s6c item one review (5 stars) accepted', null, { itemId: id32(ctx.item1), rating: 5 });
  const two = await review('s6d item two review (3 stars) accepted', null, { itemId: id32(ctx.item2), rating: 3 });
  await review('s6e duplicate (order,item) review is rejected (40105)', DUPLICATE_UNIQUE, { itemId: id32(ctx.item1), rating: 1 });
  // Same item, different order → allowed (one review per purchase).
  const again = await review('s6f item one reviewed again from order TWO (1 star) accepted', null, { orderId: id32(ctx.orderId2), itemId: id32(ctx.item1), rating: 1 });
  ctx.itemRatings = { [ctx.item1]: [one.ok ? 5 : null, again.ok ? 1 : null].filter((r) => r !== null), [ctx.item2]: [two.ok ? 3 : null].filter((r) => r !== null) };
}

async function caseS7Averages(ctx) {
  const { battery } = ctx;
  console.log('\n--- s7. proved averages agree with the written ratings ---');
  await settle();
  const expected = ctx.reviews;
  const store = await battery.averageBy('storeReview', 'rating', [['storeId', '==', ctx.storeId]]);
  const delta = { count: store.count - ctx.baseline.store.count, sum: store.sum - ctx.baseline.store.sum };
  battery.check("s7a store average: count and sum grew by exactly this run's reviews", delta.count === expected.length && delta.sum === sum(expected), `delta=${JSON.stringify(delta)} expected=${JSON.stringify(expected)} total=${JSON.stringify(store)}`);
  battery.workingShapes.push({ label: 'store average (documents.average, rating)', shape: { documentTypeName: 'storeReview', where: [['storeId', '==', '<storeId>']], property: 'rating' } });

  const buckets = await ratingDistribution(battery, ctx.storeId);
  const bucketDelta = Object.fromEntries(RATINGS.map((rating) => [rating, buckets[rating] - ctx.baseline.dist[rating]]));
  const wantBuckets = Object.fromEntries(RATINGS.map((rating) => [rating, expected.filter((r) => r === rating).length]));
  battery.check("s7c rating distribution (grouped count over rating in [1..5]) grew by this run's reviews", JSON.stringify(bucketDelta) === JSON.stringify(wantBuckets), `delta=${JSON.stringify(bucketDelta)} expected=${JSON.stringify(wantBuckets)}`);
  ctx.storeTotals = store;
  battery.workingShapes.push({ label: 'rating distribution (grouped count)', shape: { documentTypeName: 'storeReview', where: [['storeId', '==', '<storeId>'], ['rating', 'in', RATINGS]], groupBy: ['rating'] } });

  // v6 drops the per-item tree: an item's average is read with its store pinned (storeItemRating).
  for (const [itemId, ratings] of Object.entries(ctx.itemRatings ?? {})) {
    const pinned = await battery.averageBy('itemReview', 'rating', [['storeId', '==', ctx.storeId], ['itemId', '==', itemId]]);
    battery.check(`s7e item ${itemId.slice(0, 6)} average pinned to the store: count/sum match`, pinned.count === ratings.length && pinned.sum === sum(ratings), `count=${pinned.count} sum=${pinned.sum} expected=${JSON.stringify(ratings)}`);
  }
}

async function caseS8Rankings(ctx) {
  const { battery } = ctx;
  console.log('\n--- s8. rankings: stores by average, items per store ---');
  const totals = ctx.storeTotals ?? (await battery.averageBy('storeReview', 'rating', [['storeId', '==', ctx.storeId]]));
  const storeAvg = totals.sum / totals.count;
  const byAvg = await battery.ranked('storeReview', 'storeId', { type: 'avg', property: 'rating' });
  battery.check('s8a top stores by average rating carries our store at its exact average', battery.approx(battery.avgOf(byAvg.page, ctx.storeId), storeAvg), `page=${battery.avgOf(byAvg.page, ctx.storeId)} expected=${storeAvg} entries=${byAvg.page.entries.length}`);
  battery.workingShapes.push({ label: 'top stores by average rating', shape: { ...byAvg.shape, dataContractId: '<contractId>' } });

  for (const [itemId, ratings] of Object.entries(ctx.itemRatings ?? {})) {
    const avg = sum(ratings) / ratings.length;
    const pinned = await battery.ranked('itemReview', 'itemId', { type: 'avg', property: 'rating' }, { where: [['storeId', '==', ctx.storeId]] });
    battery.check(`s8e store-pinned top items carries item ${itemId.slice(0, 6)} at ${avg}`, battery.approx(battery.avgOf(pinned.page, itemId), avg), `page=${battery.avgOf(pinned.page, itemId)} entries=${pinned.page.entries.length}`);
    if (!battery.workingShapes.some((entry) => entry.label === 'top items in a store')) battery.workingShapes.push({ label: 'top items in a store', shape: { ...pinned.shape, where: [['storeId', '==', '<storeId>']], dataContractId: '<contractId>' } });
  }
  // storeItemRating has no ranked count, so only the average axis ranks items.
  const havingShape = { dataContractId: ctx.contractId, documentTypeName: 'itemReview', where: [['storeId', '==', ctx.storeId]], groupBy: 'itemId', aggregate: { type: 'avg', property: 'rating' }, having: { operator: '>=', value: 3 }, direction: 'desc', limit: 100 };
  const having = await battery.readback(() => battery.sdk.documents.having(havingShape));
  const ids = having.entries.map((entry) => entry.groupValue);
  const item1Avg = sum(ctx.itemRatings[ctx.item1]) / ctx.itemRatings[ctx.item1].length;
  battery.check('s8g HAVING avg >= 3 includes item two (3.0) and includes item one iff its average is >= 3', ids.includes(ctx.item2) && (item1Avg >= 3) === ids.includes(ctx.item1), `ids=${ids.length} item1Avg=${item1Avg} item1In=${ids.includes(ctx.item1)} item2In=${ids.includes(ctx.item2)}`);
  battery.workingShapes.push({ label: 'items in a store rated >= 3 (having)', shape: { ...havingShape, where: [['storeId', '==', '<storeId>']], dataContractId: '<contractId>' } });
}

async function caseS9OrderCounts(ctx) {
  const { battery } = ctx;
  console.log('\n--- s9. order counts (buyerOrders, storeOrders) + most-ordered stores ---');
  // v6: a seller has one store, so its order count IS the store's (no sellerId index).
  const [buyerCount, storeCount] = await Promise.all([
    battery.countBy('storeOrder', [['$ownerId', '==', ctx.buyer.ownerId]]),
    battery.countBy('storeOrder', [['storeId', '==', ctx.storeId]]),
  ]);
  battery.check("s9a buyer and store order counts read; the store count grew by this run's 2 orders", buyerCount >= 2 && storeCount - ctx.baseline.orders === 2, `buyer=${buyerCount} store=${storeCount} baseline=${ctx.baseline.orders}`);
  const most = await battery.checkRanked('s9b most-ordered stores ranking carries our store at the proved count', 'storeOrder', 'storeId', ctx.storeId, storeCount);
  if (most) battery.workingShapes.push({ label: 'most ordered stores', shape: { ...most.shape, dataContractId: '<contractId>' } });
}

async function caseS10Composite(ctx) {
  const { battery } = ctx;
  console.log('\n--- s10. composite: store page and orders page in one proof each ---');
  // v6 counts an item's reviews only under its store (storeItemRating), which a
  // per-item bind cannot pin, so the page reads them as a grouped count instead (s10c).
  const storeSubQueries = [{ documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } }];
  try {
    const page = await battery.readback(() => battery.sdk.documents.composite({ dataContractId: ctx.contractId, documentType: 'storeItem', where: [['storeId', '==', ctx.storeId]], orderBy: [['$createdAt', 'asc']], limit: 20, subQueries: storeSubQueries }));
    const stores = page.subResults[0]?.kind === 'documents' ? page.subResults[0].documents : [];
    battery.check('s10a store page composite: items + store join', page.pageDocuments.length >= 2 && stores.length === 1, `items=${page.pageDocuments.length} stores=${stores.length}`);
    battery.workingShapes.push({ label: 'store page composite', shape: { documentType: 'storeItem', where: [['storeId', '==', '<storeId>']], subQueries: storeSubQueries } });
  } catch (e) {
    battery.check('s10a store page composite', false, describeErr(e).slice(0, 220));
  }
  const orderSubQueries = [
    // orderReview is unique per orderId: a value-bounded lookup takes no limit.
    { documentType: 'storeReview', bind: { sourceProperty: '$id', field: 'orderId' } },
    // Lookup on orderAndTime [orderId, $createdAt]: leave it unordered — components
    // inherit the page's walk direction and an orderBy must name the bound field first.
    { documentType: 'orderStatusUpdate', bind: { sourceProperty: '$id', field: 'orderId' }, limit: 100 },
    { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } },
  ];
  try {
    const orders = await battery.readback(() => battery.sdk.documents.composite({ dataContractId: ctx.contractId, documentType: 'storeOrder', where: [['$ownerId', '==', ctx.buyer.ownerId]], orderBy: [['$createdAt', 'desc']], limit: 20, subQueries: orderSubQueries }));
    const reviews = orders.subResults[0]?.kind === 'documents' ? orders.subResults[0].documents : [];
    const statuses = orders.subResults[1]?.kind === 'documents' ? orders.subResults[1].documents : [];
    // Two status updates, not three: the stranger's `cancelled` is refused by the gate.
    battery.check('s10b orders page composite: orders + review-exists + status history + store join', orders.pageDocuments.length >= 2 && reviews.length >= 2 && statuses.length >= 2, `orders=${orders.pageDocuments.length} reviews=${reviews.length} statuses=${statuses.length}`);
    battery.workingShapes.push({ label: 'buyer orders composite', shape: { documentType: 'storeOrder', where: [['$ownerId', '==', '<buyerId>']], subQueries: orderSubQueries } });
  } catch (e) {
    battery.check('s10b orders page composite', false, describeErr(e).slice(0, 220));
  }
  // The store page's per-item review counts: one grouped count, the store pinned.
  const counts = await battery.groupedCount('itemReview', [['storeId', '==', ctx.storeId], ['itemId', 'in', [ctx.item1, ctx.item2].filter(Boolean)]], ['itemId'], (key) => bs58.encode(Buffer.from(key, 'hex')));
  battery.check('s10c per-item review counts (storeItemRating, store pinned, grouped by itemId)', counts.get(ctx.item1) === 2 && counts.get(ctx.item2) === 1, `c1=${counts.get(ctx.item1)} c2=${counts.get(ctx.item2)}`);
  battery.workingShapes.push({ label: 'per-item review counts in a store', shape: { documentTypeName: 'itemReview', where: [['storeId', '==', '<storeId>'], ['itemId', 'in', ['<itemIds>']]], groupBy: ['itemId'] } });
}

async function caseS11Permanence(ctx) {
  const { battery, seller, buyer } = ctx;
  console.log('\n--- s11. permanence: store/item/order cannot be deleted; tombstone by status ---');
  for (const [label, who, docType, id] of [
    ['s11a store delete is rejected', seller, 'store', ctx.storeId],
    ['s11b item delete is rejected', seller, 'storeItem', ctx.item2],
    ['s11c order delete is rejected', buyer, 'storeOrder', ctx.orderId2],
  ]) await battery.probeDelete(label, DELETE_FORBIDDEN, who, docType, id);
  await battery.probeReplace('s11d item tombstone (status=deleted) by replace is accepted', null, seller, 'storeItem', ctx.item2, itemData({ storeId: id32(ctx.storeId), title: `Gadget ${ctx.run}`, status: 'deleted' }), await battery.revisionOf('storeItem', ctx.item2));
}

async function caseS12ActionFees(ctx) {
  const { battery, seller, buyer, run } = ctx;
  console.log('\n--- s12. action fees: priced creates need the declared agreement; the rest need none ---');
  if (!(await ensureSellerStore(ctx))) { battery.check('s12 fixture', false, 'no seller store'); return; }
  const item = (label, expect, options) => battery.probeCreate(label, expect, seller, 'storeItem', itemData({ storeId: id32(ctx.storeId), title: `Fee ${run} ${label.slice(0, 4)}` }), options);
  await item('s12a an item WITHOUT the action fee agreement is refused (40132)', AGREEMENT_NOT_SET, { noAgreement: true });
  // ABOVE the declared moderators fee: a LOWER one on an elected contract is a discount claim (40139).
  const declared = actionFeeFor('storeItem', SCHEMAS);
  const agreement = new DocumentActionFeeAgreement(actionFeeAgreementOptions({ ...declared, moderators: declared.moderators + 1n }, await feeMultiplierPermille(battery.sdk)));
  await item('s12b an item agreeing to a different moderators fee is refused (40133)', AGREEMENT_MISMATCH, { agreement });
  await item('s12c an item with the declared agreement lands', null);
  // Orders, status updates, deliveries and shipping zones are free (no actionFees): no agreement at all.
  await battery.probeCreate('s12d an order carries no agreement and lands', null, buyer, 'storeOrder', orderData({ storeId: id32(ctx.storeId), sellerId: id32(seller.ownerId) }));
}

async function caseS13Immutable(ctx) {
  const { battery, seller, run } = ctx;
  console.log('\n--- s13. immutable storeId on items and shipping zones ---');
  if (!ctx.item1 || !ctx.strangerStoreId) { battery.check('s13 immutability', false, 'fixtures missing'); return; }
  // A REAL target store, so the rejection is about immutability — which fires before
  // the writer gate the move would also trip.
  const revision = await battery.revisionOf('storeItem', ctx.item1);
  await battery.probeReplace('s13a a replace moving a storeItem to another store is rejected (40128)', IMMUTABLE_CHANGED, seller, 'storeItem', ctx.item1, itemData({ storeId: id32(ctx.strangerStoreId), title: `Widget ${run}` }), revision);
  await battery.probeReplace('s13b a replace that leaves storeId alone still goes through', null, seller, 'storeItem', ctx.item1, itemData({ storeId: id32(ctx.storeId), title: `Widget ${run} (renamed)` }), revision);
  if (!ctx.zoneId) { battery.check('s13c shippingZone immutability', false, 'no zone fixture'); return; }
  await battery.probeReplace('s13c a replace moving a shippingZone to another store is rejected (40128)', IMMUTABLE_CHANGED, seller, 'shippingZone', ctx.zoneId, zoneData({ storeId: id32(ctx.strangerStoreId), name: `zone${run}` }), await battery.revisionOf('shippingZone', ctx.zoneId));
}

async function caseS14Ban(ctx) {
  const { battery, stranger, run } = ctx;
  // The stranger owns a store; a new shipping zone under it is the cheapest write.
  const zone = () => battery.attemptCreate(stranger, 'shippingZone', zoneData({ storeId: id32(ctx.strangerStoreId), name: `banned-${run}-${Date.now()}` }));
  await caseBan(ctx, { prefix: 's14', target: stranger, writeWhileBanned: zone, writeAfterUnban: zone });
}

async function caseS15ModeratorDelete(ctx) {
  const { battery, buyer } = ctx;
  console.log('\n--- s15. moderator deletes reviews; the proved average follows ---');
  if (!ctx.orderId || !ctx.item1) { battery.check('s15 fixtures', false, 'fixtures missing'); return; }
  // The buyer's store review on order one (s5f) and item review on item one (s6c).
  const [storeReview] = await battery.queryDocs('storeReview', { where: [['orderId', '==', ctx.orderId]], limit: 1 });
  const [itemReview] = await battery.queryDocs('itemReview', { where: [['orderId', '==', ctx.orderId], ['itemId', '==', ctx.item1]], limit: 1 });
  const before = await battery.averageBy('storeReview', 'rating', [['storeId', '==', ctx.storeId]]);
  await caseModeratorDelete(ctx, {
    prefix: 's15', docType: 'storeReview', documentId: storeReview ? battery.b58(storeReview.$id) : null, ownerId: buyer.ownerId,
    afterwards: async () => {
      const after = await battery.averageBy('storeReview', 'rating', [['storeId', '==', ctx.storeId]]);
      battery.check('s15d the store\'s proved rating average dropped the removed review', after.count === before.count - 1, `count ${before.count}→${after.count}`);
    },
  });
  await caseModeratorDelete(ctx, { prefix: 's16', docType: 'itemReview', documentId: itemReview ? battery.b58(itemReview.$id) : null, ownerId: buyer.ownerId });
}

async function caseS17Warn(ctx) {
  const { battery, stranger, run } = ctx;
  const zone = () => battery.attemptCreate(stranger, 'shippingZone', zoneData({ storeId: id32(ctx.strangerStoreId), name: `warned-${run}-${Date.now()}` }));
  await caseWarn(ctx, { prefix: 's17', target: stranger, writeWhileWarned: zone });
}

async function caseS18TypedArrays(ctx) {
  const { battery, seller, run } = ctx;
  console.log('\n--- s18. storeItem tags and imageUrls are typed string arrays (beta.4 v4) ---');
  const tags = ['catan', 'wood', 'handmade'];
  const imageUrls = ['https://example.com/a.png', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'];
  const item = await battery.probeCreate('s18a an item with tags and imageUrls as LISTS lands', null, seller, 'storeItem', itemData({ storeId: id32(ctx.storeId), title: `Typed ${run}`, tags, imageUrls }));
  if (item.ok) {
    const back = (await battery.fetchDocument('storeItem', item.id))?.toJSON?.();
    battery.check('s18b both read back as the same lists', JSON.stringify(back?.tags) === JSON.stringify(tags) && JSON.stringify(back?.imageUrls) === JSON.stringify(imageUrls), JSON.stringify({ tags: back?.tags, imageUrls: back?.imageUrls }));
  }
  const create = (label, data) => battery.probeCreate(label, ARRAY_OUT_OF_BOUNDS, seller, 'storeItem', itemData({ storeId: id32(ctx.storeId), title: `Bad ${run} ${label.slice(0, 4)}`, ...data }));
  await create('s18c an image URL that is not http(s):// or ipfs:// is refused (pattern)', { imageUrls: ['ftp://example.com/a.png'] });
  await create('s18d a ninth image is refused (maxItems 8)', { imageUrls: Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.png`) });
  await create('s18e a duplicate tag is refused (uniqueItems)', { tags: ['wood', 'wood'] });
  await battery.probeCreate('s18f the v3 JSON-string encoding is refused on v4', NOT_A_LIST, seller, 'storeItem', itemData({ storeId: id32(ctx.storeId), title: `Legacy ${run}`, tags: JSON.stringify(tags) }));
}

async function caseS19SelfOrder(ctx) {
  const { battery, seller } = ctx;
  console.log('\n--- s19. a seller cannot order from their own store (storeOrder.sellerId distinctFrom $ownerId) ---');
  // Before v6 the self-order landed and only storeReview's distinctFrom stopped
  // the self-rating that followed. v6 refuses the order itself, so a seller can
  // neither pad their order counts nor reach the review step.
  await battery.probeCreate('s19a the seller ordering from their own store is refused (10419 sellerId = $ownerId)', NOT_DISTINCT, seller, 'storeOrder', orderData({ storeId: id32(ctx.storeId), sellerId: id32(seller.ownerId) }));
}

/** The seller's store: s1's fixture, or (for `--only s20`) the seller's existing store, created if absent. */
async function ensureSellerStore(ctx) {
  if (ctx.storeId) return ctx.storeId;
  const { battery, seller } = ctx;
  const [first] = await battery.queryDocs('store', { where: [['$ownerId', '==', seller.ownerId]], limit: 1 });
  if (first) ctx.storeId = battery.b58(first.$id);
  else {
    const created = await battery.probeCreate('s20 seller store created', null, seller, 'store', storeData({ name: 'Ann Store' }));
    ctx.storeId = created.ok ? created.id : null;
  }
  return ctx.storeId;
}

async function caseS20PropertyConstraints(ctx) {
  const { battery, seller } = ctx;
  console.log('\n--- s20. propertyConstraints: currency and tier co-occurrence (10422) ---');
  if (!(await ensureSellerStore(ctx))) { battery.check('s20 fixture', false, 'no seller store'); return; }
  // Under the seller's real store, so the writer gate passes and only the rule can refuse.
  for (const docType of ['storeItem', 'shippingZone']) {
    for (const [label, data, rule] of refusedCreates(CONTRACT_FILE, docType)) {
      await battery.probeCreate(`s20 ${label} is refused (10422 ${rule})`, constraintViolation(rule), seller, docType, { ...data, storeId: id32(ctx.storeId) });
    }
  }
  // The accepted side: s1c/s1d (priced items) and s2c (a flat zone with rate and currency).
}

async function caseS21StoreMustBeOpen(ctx) {
  const { battery, buyer, stranger, run } = ctx;
  console.log('\n--- s21. QA D-25: only an active store takes orders (storeStatus bound to store.status, storeIsOpen) ---');
  // The stranger's store (s1b) is paused and reopened by its own owner; the
  // seller's store stays active for every other case.
  const storeId = ctx.strangerStoreId;
  if (!storeId) { battery.check('s21 fixture', false, 'no stranger store'); return; }
  const place = (label, expect, storeStatus) => battery.probeCreate(label, expect, buyer, 'storeOrder', orderData({ storeId: id32(storeId), sellerId: id32(stranger.ownerId), storeStatus }));
  // A reused store keeps its own name and category through the status flips.
  const current = (await battery.fetchDocument('store', storeId))?.toJSON?.() ?? {};
  const fields = { name: current.name ?? `Cy Store ${run}`, category: current.category ?? CATEGORY };
  const setStatus = async (status) => battery.probeReplace(`s21 the owner sets the store ${status}`, null, stranger, 'store', storeId, storeData({ ...fields, status }), await battery.revisionOf('store', storeId));
  try {
    await place('s21a an order at the active store lands', null, 'active');
    // The rule runs in the structure stage, before the `where` state read: a
    // non-active copy is 10422 whatever the store says.
    await place('s21b an order copying "paused" to an active store is refused (10422 storeIsOpen, before the where)', constraintViolation('storeIsOpen'), 'paused');
    await setStatus('paused');
    await place('s21c an order at the paused store is refused (40127: storeStatus active no longer matches)', PROPERTY_MISMATCH, 'active');
    await place('s21d copying the true "paused" status is refused by the rule (10422 storeIsOpen)', constraintViolation('storeIsOpen'), 'paused');
    await setStatus('closed');
    await place('s21e an order at the closed store is refused (10422 storeIsOpen)', constraintViolation('storeIsOpen'), 'closed');
  } finally {
    await setStatus('active');
  }
  await place('s21f the reopened store takes orders again', null, 'active');
}

async function caseS22Digital(ctx) {
  const { battery, seller, buyer, stranger, run } = ctx;
  console.log('\n--- s22. digital products: fulfillment, seller-only kits, seller-written buyer-bound deliveries ---');
  if (!ctx.storeId || !ctx.strangerStoreId || !ctx.orderId) { battery.check('s22 fixtures', false, 'no store/order fixtures'); return; }
  const item = await battery.probeCreate('s22a a digital item is accepted', null, seller, 'storeItem', { ...itemData({ storeId: id32(ctx.storeId), title: `Ebook ${run}` }), fulfillment: 'digital' });
  // An enum breach is a JSON-schema refusal (10101), anchored like ARRAY_OUT_OF_BOUNDS.
  await battery.probeCreate('s22b an unknown fulfillment is refused by the enum (10101)', /\bcode"?\s*[=:]\s*10101\b|jsonschemaerror:/i, seller, 'storeItem', { ...itemData({ storeId: id32(ctx.storeId), title: `Bad ${run}` }), fulfillment: 'teleport' });
  if (!item.ok) return;

  const kit = (label, expect, who, data = {}) => battery.probeCreate(label, expect, who, 'itemDeliverable', deliverableData({ itemId: id32(item.id), ...data }));
  await kit('s22c a STRANGER writing a kit for the seller\'s item is rejected (writer gate, 40127)', WRITER_GATE, stranger);
  await kit('s22d a kit for a GHOST item is rejected (40120)', REFERENCE_NOT_FOUND, seller, { itemId: randomEntropy() });
  const created = await kit('s22e the seller\'s kit is accepted', null, seller);
  await kit('s22f a second kit for the same item is rejected (unique itemDeliverable)', DUPLICATE_UNIQUE, seller);
  if (created.ok) {
    const read = await battery.revisionOf('itemDeliverable', created.id);
    const first = deliverableData({ itemId: id32(item.id) });
    await battery.probeReplace('s22g the seller replaces the kit (a sale consumed license keys)', null, seller, 'itemDeliverable', created.id, first, read);
    // The client's reservation rests on this: a pool written from a stale read
    // (another tab delivered meanwhile) must never put sent keys back. Judged
    // by content: probeReplace's revision check would count the FIRST replace
    // as this one landing.
    const stale = deliverableData({ itemId: id32(item.id) });
    const outcome = await battery.attemptWrite(
      { accepted: async () => (await kitBytes(battery, created.id))?.equals(Buffer.from(stale.encryptedPayload)) === true },
      () => battery.sdk.documents.replace({
        document: buildDocument({ contractId: ctx.contractId, docType: 'itemDeliverable', ownerId: seller.ownerId, data: stale, revision: BigInt(read) + 1n, id: id32(created.id) }).document,
        identityKey: seller.identityKey,
        signer: seller.signer,
      })
    );
    battery.expectRejected('s22g2 a second replace from the SAME read revision is refused (40106 stale revision)', outcome, STALE_REVISION);
    battery.check('s22g3 the kit still holds the first replace', (await kitBytes(battery, created.id))?.equals(Buffer.from(first.encryptedPayload)) === true);
    // The stranger's own item is a real target, so this is about immutability.
    const strangerItem = await battery.probeCreate('s22h fixture: a stranger item', null, stranger, 'storeItem', { ...itemData({ storeId: id32(ctx.strangerStoreId), title: `Other ${run}` }), fulfillment: 'digital' });
    if (strangerItem.ok) {
      await battery.probeReplace('s22i a replace moving the kit to another item is rejected (40128)', IMMUTABLE_CHANGED, seller, 'itemDeliverable', created.id, deliverableData({ itemId: id32(strangerItem.id) }), await battery.revisionOf('itemDeliverable', created.id));
    }
  }

  const good = { orderId: id32(ctx.orderId) };
  const deliver = (label, expect, who, data = {}) => battery.probeCreate(label, expect, who, 'orderDelivery', deliveryData({ ...good, ...data }));
  const delivery = await deliver('s22j the seller delivers the order', null, seller);
  await battery.probeCreate('s22k a delivery still carrying buyerId is refused (10101: v6 derives it)', SCHEMA_REFUSED, seller, 'orderDelivery',
    { ...deliveryData(good), buyerId: id32(buyer.ownerId) });
  await deliver('s22l a delivery for a GHOST order is rejected (40120)', REFERENCE_NOT_FOUND, seller, { orderId: randomEntropy() });
  await deliver('s22m a STRANGER delivering to the buyer is rejected (writer gate, 40127)', WRITER_GATE, stranger);
  await deliver('s22n the BUYER cannot write a delivery to themselves (writer gate, 40127)', WRITER_GATE, buyer);
  await deliver('s22o a second delivery for the same order is accepted (re-send)', null, seller);
  if (delivery.ok) {
    await battery.probeDelete('s22p a delivery cannot be deleted (it is the buyer\'s receipt)', DELETE_FORBIDDEN, seller, 'orderDelivery', delivery.id);
    await battery.probeReplace('s22p2 a delivery cannot be rewritten (documentsMutable: false)', NOT_MUTABLE, seller, 'orderDelivery', delivery.id, deliveryData(good), 1n);
  }
  await settle();
  const rows = await battery.queryDocs('orderDelivery', buyerFeedQuery(buyer.ownerId));
  const mine = rows.filter((row) => battery.b58(row.orderId) === ctx.orderId);
  battery.check('s22q buyerDeliveries (orderId.$ownerId) serves the buyer\'s library, and the order\'s deliveries are the seller\'s', mine.length >= 2 && mine.every((row) => battery.b58(row.$ownerId) === seller.ownerId), `rows=${rows.length} thisOrder=${mine.length}`);
  battery.workingShapes.push({ label: 'buyer library', shape: { documentTypeName: 'orderDelivery', ...buyerFeedQuery('<buyerId>') } });
}

/** The newest active stores (`byStatus`), and with `category` the newest in it (`byCategory`); `before` bounds `$createdAt` from above. */
const newestStores = ({ category, before } = {}) => ({
  where: [['status', '==', 'active'], ...(category ? [['category', '==', category]] : []), ...(before ? [['$createdAt', '<=', before]] : [])],
  orderBy: [['status', 'asc'], ...(category ? [['category', 'asc']] : []), ['$createdAt', 'desc']],
});

async function caseS23Categories(ctx) {
  const { battery, seller } = ctx;
  console.log('\n--- s23. store categories: a slug, newest by status and category, top categories ---');
  if (!(await ensureSellerStore(ctx))) { battery.check('s23 fixture', false, 'no seller store'); return; }
  await settle();
  // The seller's store may be a reused one (s1), filed under whatever category it was created with.
  const store = (await battery.fetchDocument('store', ctx.storeId))?.toJSON?.() ?? {};
  const { category, $createdAt: createdAt } = store;
  if (!category || store.status !== 'active') { battery.check('s23 fixture', false, `seller store category=${category} status=${store.status}`); return; }
  const isOurs = (row) => battery.b58(row.$id) === ctx.storeId;
  const newest = await battery.queryDocs('store', { ...newestStores(), limit: 100 });
  const descending = newest.every((row, i) => i === 0 || Number(newest[i - 1].$createdAt) >= Number(row.$createdAt));
  battery.check('s23a byStatus pages active stores only, newest first', newest.length > 0 && descending && newest.every((row) => row.status === 'active'), `rows=${newest.length}`);
  // Bounded at our own $createdAt, so the store is on the first page however many are newer.
  const fromOurs = await battery.queryDocs('store', { ...newestStores({ before: createdAt }), limit: 5 });
  battery.check('s23a2 a byStatus page starting at our store holds it first in line', fromOurs.some(isOurs), `rows=${fromOurs.length}`);
  battery.workingShapes.push({ label: 'newest active stores', shape: { documentTypeName: 'store', ...newestStores() } });
  const inCategory = await battery.queryDocs('store', { ...newestStores({ category, before: createdAt }), limit: 5 });
  battery.check(`s23b byCategory lists the active stores filed under ${category}, ours among them`, inCategory.some(isOurs) && inCategory.every((row) => row.category === category), `rows=${inCategory.length}`);
  battery.workingShapes.push({ label: 'newest active stores in a category', shape: { documentTypeName: 'store', ...newestStores({ category: '<category>' }) } });
  const ranked = await battery.checkRanked(`s23c top categories (ranked count at category, status pinned) carries ${category} at its proved store count`, 'store', 'category', category,
    await battery.countBy('store', [['status', '==', 'active'], ['category', '==', category]]), { where: [['status', '==', 'active']] });
  if (ranked) battery.workingShapes.push({ label: 'top store categories', shape: { ...ranked.shape, dataContractId: '<contractId>' } });
  // The category is a slug: what the client normalises to, and nothing else.
  await battery.probeReplace('s23d a category that is not a lowercase slug is refused (10101 pattern)', SCHEMA_REFUSED, seller, 'store', ctx.storeId,
    storeData({ name: store.name, category: 'Vintage Clothing' }), await battery.revisionOf('store', ctx.storeId));
}

async function caseS24ModeratorDeletesItem(ctx) {
  const { battery, seller, run } = ctx;
  if (!(await ensureSellerStore(ctx))) { battery.check('s24 fixture', false, 'no seller store'); return; }
  // v6: stores and items are moderator-deletable (their owners still cannot delete them).
  const item = await battery.probeCreate('s24 fixture: a throwaway item', null, seller, 'storeItem', itemData({ storeId: id32(ctx.storeId), title: `Takedown ${run}` }));
  await caseModeratorDelete(ctx, { prefix: 's24', docType: 'storeItem', documentId: item.ok ? item.id : null, ownerId: seller.ownerId });
}

const CASES = new Map([
  ['s1', caseS1Fixtures], ['s2', caseS2ItemRefs], ['s3', caseS3Orders], ['s4', caseS4Status],
  ['s5', caseS5StoreReviews], ['s6', caseS6ItemReviews], ['s7', caseS7Averages], ['s8', caseS8Rankings],
  ['s9', caseS9OrderCounts], ['s10', caseS10Composite], ['s11', caseS11Permanence], ['s12', caseS12ActionFees],
  ['s13', caseS13Immutable], ['s14', caseS14Ban], ['s15', caseS15ModeratorDelete],
  ['s17', caseS17Warn], ['s18', caseS18TypedArrays], ['s19', caseS19SelfOrder], ['s20', caseS20PropertyConstraints],
  ['s21', caseS21StoreMustBeOpen], ['s22', caseS22Digital], ['s23', caseS23Categories], ['s24', caseS24ModeratorDeletesItem],
]);

/** v6 shape the cases rely on beyond the per-type rules selfTestModerated checks. */
function selfTestV6() {
  const indexNames = (docType) => (SCHEMAS[docType].indices ?? []).map((entry) => entry.name);
  const moderators = CONTRACT.config?.moderation?.moderators ?? {};
  const fee = (docType) => actionFeeFor(docType, SCHEMAS)?.moderators;
  const index = (docType, name) => (SCHEMAS[docType].indices ?? []).find((entry) => entry.name === name);
  const indexProps = (docType, name) => JSON.stringify(index(docType, name)?.properties);
  const byCategory = index('store', 'byCategory');
  const derivedFeed = (docType, name) => indexProps(docType, name) === '[{"orderId.$ownerId":"asc"},{"$createdAt":"asc"}]';
  return reportSelfTest(`contracts/${CONTRACT_FILE} (storefront v6)`, [
    ['moderation is elected, seats contestable, owner protected, interim the contract owner', moderators.$type === 'elected' && moderators.seatContestable === true && moderators.ownerProtected === true && moderators.interim?.$type === 'contractOwner'],
    ['no doctype carries a tokenCost (nothing costs YAPP)', Object.values(SCHEMAS).every((schema) => schema.tokenCost === undefined)],
    ['store, storeItem, storeReview and itemReview creates declare 1000M / 50M / 16M / 8M moderators fees (s5e, s12)', fee('store') === 1_000_000_000n && fee('storeItem') === 50_000_000n && fee('storeReview') === 16_000_000n && fee('itemReview') === 8_000_000n],
    ['orders, status updates, deliveries, kits, zones and addresses are unpriced (s12d)', ['storeOrder', 'orderStatusUpdate', 'orderDelivery', 'itemDeliverable', 'shippingZone', 'savedAddress'].every((docType) => actionFeeFor(docType, SCHEMAS) === null)],
    ['store requires a lowercase-slug category of at most 20 characters (s23d)', SCHEMAS.store.required.includes('category') && SCHEMAS.store.properties.category.pattern === '^[a-z0-9]+(-[a-z0-9]+)*$' && SCHEMAS.store.properties.category.maxLength === 20],
    ['store byStatus [status, $createdAt] and byCategory [status, category, $createdAt] (rangeCountable, ranked at category; s23)', indexProps('store', 'byStatus') === '[{"status":"asc"},{"$createdAt":"asc"}]'
      && indexProps('store', 'byCategory') === '[{"status":"asc"},{"category":"asc"},{"$createdAt":"asc"}]' && byCategory?.rangeCountable === true && byCategory?.rankedCountable?.at === 'category'],
    ['storeOrder.sellerId is distinctFrom $ownerId (s19)', SCHEMAS.storeOrder.properties.sellerId.distinctFrom === '$ownerId'],
    ['order counts ride buyerOrders and storeOrders (rangeCountable; storeOrders ranked at storeId; s9)', index('storeOrder', 'buyerOrders')?.rangeCountable === true && index('storeOrder', 'storeOrders')?.rangeCountable === true && index('storeOrder', 'storeOrders')?.rankedCountable?.at === 'storeId'],
    ['status updates and deliveries store no buyerId; buyerFeed and buyerDeliveries derive it (s4g, s22q)', !SCHEMAS.orderStatusUpdate.properties.buyerId && !SCHEMAS.orderDelivery.properties.buyerId && derivedFeed('orderStatusUpdate', 'buyerFeed') && derivedFeed('orderDelivery', 'buyerDeliveries')],
    ['a status update is neither deletable nor mutable (s4h)', SCHEMAS.orderStatusUpdate.canBeDeleted === false && SCHEMAS.orderStatusUpdate.documentsMutable === false],
    ['encrypted payloads cap at 5,120 B and variants at 5,120 chars/bytes', ['storeOrder', 'orderDelivery', 'itemDeliverable'].every((docType) => SCHEMAS[docType].properties.encryptedPayload.maxItems === 5120)
      && SCHEMAS.storeItem.properties.variants.maxLength === 5120 && SCHEMAS.storeItem.properties.variants.maxBytes === 5120],
    ['the dropped indexes are gone (per-seller and per-buyer review/order indexes, the count twins, itemRating, the item status/owner/category scans)',
      ['sellerOrders', 'buyerOrderCount', 'sellerOrderCount', 'storeOrderCount'].every((name) => !indexNames('storeOrder').includes(name))
      && ['sellerReviews', 'buyerReviews', 'sellerRating'].every((name) => !indexNames('storeReview').includes(name))
      && ['buyerItemReviews', 'itemRating'].every((name) => !indexNames('itemReview').includes(name))
      && ['ownerAndTime', 'statusAndTime', 'categoryAndTime'].every((name) => !indexNames('storeItem').includes(name))
      && !indexNames('orderStatusUpdate').includes('sellerStatusUpdates')],
    ['item ratings ride storeItemRating [storeId, itemId] (s7e, s10c)', indexProps('itemReview', 'storeItemRating') === '[{"storeId":"asc"},{"itemId":"asc"}]' && index('itemReview', 'storeItemRating')?.rangeCountable === true],
  ]);
}

/** The per-type rules (references, gates, immutables, constraints, moderation) the cases rely on. */
function selfTestRules() {
  // s2d/s2e + s13: only the store owner may list under a store, and never move it.
  const ownedByStoreOwner = { where: { storeId: { $ownerId: '$ownerId' } }, immutable: ['storeId'] };
  const constraints = DECLARED_RULES[CONTRACT_FILE];
  return selfTestModerated(CONTRACT_FILE, {
    // s18: tags and imageUrls are typed string arrays (beta.4 v4). s20: propertyConstraints (beta.5). s24: moderator-deletable (v6).
    storeItem: { ...ownedByStoreOwner, moderatorDeletable: true, typedArrays: { tags: { items: 'string', maxItems: 32, maxLength: 64 }, imageUrls: { items: 'string', maxItems: 8, maxLength: 512 } }, constraints: constraints.storeItem },
    shippingZone: { ...ownedByStoreOwner, constraints: constraints.shippingZone },
    // s3d: sellerId is the store's real owner, not a buyer's claim. s21 (QA D-25):
    // storeStatus is the store's real status, and only an active store takes orders.
    storeOrder: { where: { storeId: { $ownerId: 'sellerId', status: 'storeStatus' } }, constraints: constraints.storeOrder },
    // s4d/s4e: only the seller posts status updates (the buyer is derived, not copied).
    orderStatusUpdate: { where: { orderId: { sellerId: '$ownerId' } } },
    // s5c/s6: only the identity that placed the order may review it.
    // s15/s16: reviews are moderator-deletable; so are stores and items (v6),
    // whose references are all moderatedDocument references.
    // s19: the seller is never the reviewer (and, on v6, never the buyer).
    storeReview: { where: { orderId: { storeId: 'storeId', sellerId: 'sellerId', $ownerId: '$ownerId' } }, moderatorDeletable: true, distinctFromOwner: ['sellerId'] },
    itemReview: { where: { itemId: { storeId: 'storeId' }, orderId: { storeId: 'storeId', $ownerId: '$ownerId' } }, moderatorDeletable: true },
    store: { moderatorDeletable: true },
    // s22: only an item's owner keeps its kit, which never moves; only an
    // order's seller delivers it (the buyer is derived through the order).
    itemDeliverable: { where: { itemId: { $ownerId: '$ownerId' } }, immutable: ['itemId'] },
    orderDelivery: { where: { orderId: { sellerId: '$ownerId' } } },
  }, { moderation: { banlist: true, suspensions: true, warnings: true } });
}

await runBattery({
  label: 'storefront',
  contract: { env: 'STOREFRONT_CONTRACT_ID' },
  cases: CASES,
  actors: { seller: 200, buyer: 201, stranger: 202 },
  flags: { moderator: { ...MODERATOR_FLAG, default: 'maker' } },
  // Every create of a priced type (store, storeItem, storeReview, itemReview) carries the declared
  // agreement, unless a case opts out (`noAgreement`, s5e/s12a) or names its own (`agreement`, s12b).
  agreementFor: (sdk, docType) => feeAgreementFor(sdk, docType, SCHEMAS),
  selfTest: () => Math.max(selfTestV6(), selfTestRules()),
  setup: async ({ battery, args }) => {
    const moderator = await battery.moderatorActor(args.moderator);
    console.log(`moderator=${moderator.label}`);
    return { reviews: [], itemRatings: {}, zoneId: null, moderator };
  },
  summary: (ctx) => `store=${ctx.storeId} items=${ctx.item1},${ctx.item2} orders=${ctx.orderId},${ctx.orderId2}`,
});
