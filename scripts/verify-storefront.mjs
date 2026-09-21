/**
 * Registration-day battery for the **storefront contract**
 * (`contracts/yappr-storefront-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run
 * live on a beta.1+ devnet. Actors are seed-ledger personas: a SELLER, a BUYER and
 * a STRANGER; reviews cost YAPP, so the buyer and stranger are topped up first.
 *
 *   NETWORK=devnet node scripts/verify-storefront.mjs --contract <id> \
 *     [--seller 200] [--buyer 201] [--stranger 202] [--moderator 203] [--yapp 60] [--only s5,s7]
 *
 * `--moderator` is the persona the contract was published under (its owner) or
 * one appointed at publish time; v3 (beta.3) is a moderated cut, so s14/s15
 * ban the stranger and take reviews down.
 *   node scripts/verify-storefront.mjs --self-test   # offline: contract declares what the cases assert
 */
import bs58 from 'bs58';
import {
  DELETE_FORBIDDEN, DUPLICATE_UNIQUE, IMMUTABLE_CHANGED, PROPERTY_MISMATCH, REFERENCE_NOT_FOUND,
  TOKEN_AGREEMENT_MISSING, decodeIntGroupKey, id32, runBattery, settle,
} from './battery-lib.mjs';
import { describeErr, randomEntropy } from './seed/seed-lib.mjs';
import { caseBan, caseModeratorDelete, selfTestModerated } from './battery-moderation.mjs';

const REVIEW_COST = { storeReview: 3n, itemReview: 1n };
const DEFAULT_YAPP = 60n;
const RATINGS = [1, 2, 3, 4, 5];
// A writer gate (`propertyAgreement` with `$ownerId` on the REFERRING side) fails
// as the same 40127 a value pair does — the signer IS the referring side.
const WRITER_GATE = PROPERTY_MISMATCH;

// ---- Document shapes --------------------------------------------------------

const storeData = ({ name, status = 'active' }) => ({ name, status, description: 'storefront battery' });
const itemData = ({ storeId, title, status = 'active' }) => ({ storeId, title, status, basePrice: 1000, currency: 'USD' });
const zoneData = ({ storeId, name }) => ({ storeId, name, rateType: 'flat', flatRate: 500, currency: 'USD', priority: 1 });
// No buyerId anywhere: the buyer is the order's $ownerId, and the documents that
// need to name it bind to that through propertyAgreement.
const orderData = ({ storeId, sellerId }) => ({ storeId, sellerId, encryptedPayload: crypto.getRandomValues(new Uint8Array(64)), nonce: crypto.getRandomValues(new Uint8Array(24)) });
const statusData = ({ orderId, buyerId, status = 'shipped', message }) => ({ orderId, buyerId, status, ...(message ? { message } : {}) });
const storeReviewData = ({ storeId, orderId, sellerId, rating, title }) => ({ storeId, orderId, sellerId, rating, ...(title ? { title } : {}) });
const itemReviewData = ({ storeId, itemId, orderId, rating }) => ({ storeId, itemId, orderId, rating });
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
  console.log('\n--- s4. status updates: writer gate on the seller, buyerId agreed ---');
  if (!ctx.orderId) { battery.check('s4 status', false, 'no order fixture'); return; }
  const good = { orderId: id32(ctx.orderId), buyerId: id32(buyer.ownerId) };
  const update = (label, expect, who, data) => battery.probeCreate(label, expect, who, 'orderStatusUpdate', statusData({ ...good, ...data }));
  await update('s4a seller status update is accepted', null, seller, { status: 'processing' });
  await update('s4b status update with the WRONG buyerId is rejected (40127)', PROPERTY_MISMATCH, seller, { buyerId: id32(stranger.ownerId) });
  await update('s4c status update on a GHOST order is rejected (40120)', REFERENCE_NOT_FOUND, seller, { orderId: randomEntropy() });
  // THE GAP THAT CLOSED: a stranger could post an update carrying the order's own
  // ids and only the client hid it. `{$ownerId: sellerId}` refuses it at write time.
  await update('s4d a STRANGER posting an update on the order is rejected (writer gate, 40127)', WRITER_GATE, stranger, { status: 'cancelled', message: 'spoof' });
  await update('s4e even the BUYER cannot post a status update on their own order (writer gate, 40127)', WRITER_GATE, buyer, { status: 'cancelled' });
  await update('s4f seller ships the order', null, seller, { status: 'shipped' });
  await settle();
  const rows = await battery.queryDocs('orderStatusUpdate', { where: [['buyerId', '==', buyer.ownerId]], orderBy: [['$createdAt', 'desc']], limit: 10 });
  const foreign = rows.filter((row) => battery.b58(row.$ownerId) !== seller.ownerId);
  battery.check("s4g buyerStatusUpdates serves the buyer's feed, and EVERY row on it was written by the seller", rows.length >= 2 && foreign.length === 0, `rows=${rows.length} foreign=${foreign.length}`);
  battery.workingShapes.push({ label: 'buyer status feed', shape: { documentTypeName: 'orderStatusUpdate', where: [['buyerId', '==', '<buyerId>']], orderBy: [['$createdAt', 'desc']] } });
}

async function caseS5StoreReviews(ctx) {
  const { battery, seller, buyer, stranger } = ctx;
  console.log('\n--- s5. store reviews: agreement chain, uniqueness, token cost ---');
  if (!ctx.orderId || !ctx.orderId2) { battery.check('s5 reviews', false, 'no order fixtures'); return; }
  const good = { storeId: id32(ctx.storeId), orderId: id32(ctx.orderId), sellerId: id32(seller.ownerId), rating: 5 };
  const paid = { tokenCost: REVIEW_COST.storeReview };
  const review = (label, expect, who, data, options = paid) => battery.probeCreate(label, expect, who, 'storeReview', storeReviewData({ ...good, ...data }), options);
  await review('s5a review with the WRONG storeId is rejected (40127)', PROPERTY_MISMATCH, buyer, { storeId: id32(ctx.strangerStoreId) });
  await review('s5b review with the WRONG sellerId is rejected (40127)', PROPERTY_MISMATCH, buyer, { sellerId: id32(stranger.ownerId) });
  // THE GAP THAT CLOSED: a stranger could review someone else's order if it carried
  // the right ids. The gate refuses it outright, BEFORE the buyer's own review exists.
  await review("s5c a STRANGER reviewing the buyer's order is rejected (writer gate, 40127)", WRITER_GATE, stranger, { rating: 1 });
  await review('s5d review on a GHOST order is rejected (40120)', REFERENCE_NOT_FOUND, buyer, { orderId: randomEntropy() });
  await review('s5e review WITHOUT a token payment agreement is rejected', TOKEN_AGREEMENT_MISSING, buyer, {}, { noPayment: true });
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
  const review = (label, expect, data) => battery.probeCreate(label, expect, buyer, 'itemReview', itemReviewData({ ...base, ...data }), { tokenCost: REVIEW_COST.itemReview });
  await review("s6a item review of an item from ANOTHER store is rejected (40127 on the item's storeId agreement)", PROPERTY_MISMATCH, { itemId: id32(ctx.foreignItem), rating: 5 });
  await review('s6b item review of a GHOST item is rejected (40120)', REFERENCE_NOT_FOUND, { itemId: randomEntropy(), rating: 5 });
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
  // Also proves `sellerId` is itself an averageable axis, not just arithmetic.
  const seller = await battery.averageBy('storeReview', 'rating', [['sellerId', '==', ctx.seller.ownerId]]);
  battery.check('s7b seller average agrees with the store average (one store per seller)', seller.count === store.count && seller.sum === store.sum, `count=${seller.count} sum=${seller.sum}`);
  battery.workingShapes.push({ label: 'store average (documents.average, rating)', shape: { documentTypeName: 'storeReview', where: [['storeId', '==', '<storeId>']], property: 'rating' } });

  const buckets = await ratingDistribution(battery, ctx.storeId);
  const bucketDelta = Object.fromEntries(RATINGS.map((rating) => [rating, buckets[rating] - ctx.baseline.dist[rating]]));
  const wantBuckets = Object.fromEntries(RATINGS.map((rating) => [rating, expected.filter((r) => r === rating).length]));
  battery.check("s7c rating distribution (grouped count over rating in [1..5]) grew by this run's reviews", JSON.stringify(bucketDelta) === JSON.stringify(wantBuckets), `delta=${JSON.stringify(bucketDelta)} expected=${JSON.stringify(wantBuckets)}`);
  ctx.storeTotals = store;
  battery.workingShapes.push({ label: 'rating distribution (grouped count)', shape: { documentTypeName: 'storeReview', where: [['storeId', '==', '<storeId>'], ['rating', 'in', RATINGS]], groupBy: ['rating'] } });

  for (const [itemId, ratings] of Object.entries(ctx.itemRatings ?? {})) {
    const item = await battery.averageBy('itemReview', 'rating', [['itemId', '==', itemId]]);
    battery.check(`s7d item ${itemId.slice(0, 6)} average: count/sum match`, item.count === ratings.length && item.sum === sum(ratings), `count=${item.count} sum=${item.sum} expected=${JSON.stringify(ratings)}`);
    const pinned = await battery.averageBy('itemReview', 'rating', [['storeId', '==', ctx.storeId], ['itemId', '==', itemId]]);
    battery.check(`s7e item ${itemId.slice(0, 6)} average pinned to the store agrees`, pinned.count === item.count && pinned.sum === item.sum, `count=${pinned.count} sum=${pinned.sum}`);
  }
}

async function caseS8Rankings(ctx) {
  const { battery } = ctx;
  console.log('\n--- s8. rankings: stores/sellers by average and count, items globally and per store ---');
  const totals = ctx.storeTotals ?? (await battery.averageBy('storeReview', 'rating', [['storeId', '==', ctx.storeId]]));
  const storeAvg = totals.sum / totals.count;
  const byAvg = await battery.ranked('storeReview', 'storeId', { type: 'avg', property: 'rating' });
  battery.check('s8a top stores by average rating carries our store at its exact average', battery.approx(battery.avgOf(byAvg.page, ctx.storeId), storeAvg), `page=${battery.avgOf(byAvg.page, ctx.storeId)} expected=${storeAvg} entries=${byAvg.page.entries.length}`);
  battery.workingShapes.push({ label: 'top stores by average rating', shape: { ...byAvg.shape, dataContractId: '<contractId>' } });
  await battery.checkRanked('s8b most-reviewed stores carries our store at its proved review count', 'storeReview', 'storeId', ctx.storeId, totals.count);
  const sellers = await battery.ranked('storeReview', 'sellerId', { type: 'avg', property: 'rating' });
  battery.check('s8c top sellers by average carries our seller', battery.approx(battery.avgOf(sellers.page, ctx.seller.ownerId), storeAvg), `page=${battery.avgOf(sellers.page, ctx.seller.ownerId)}`);

  for (const [itemId, ratings] of Object.entries(ctx.itemRatings ?? {})) {
    const avg = sum(ratings) / ratings.length;
    const global = await battery.ranked('itemReview', 'itemId', { type: 'avg', property: 'rating' });
    battery.check(`s8d global top items carries item ${itemId.slice(0, 6)} at ${avg}`, battery.approx(battery.avgOf(global.page, itemId), avg), `page=${battery.avgOf(global.page, itemId)}`);
    const pinned = await battery.ranked('itemReview', 'itemId', { type: 'avg', property: 'rating' }, { where: [['storeId', '==', ctx.storeId]] });
    battery.check(`s8e store-pinned top items carries item ${itemId.slice(0, 6)} at ${avg}`, battery.approx(battery.avgOf(pinned.page, itemId), avg), `page=${battery.avgOf(pinned.page, itemId)} entries=${pinned.page.entries.length}`);
    if (!battery.workingShapes.some((entry) => entry.label === 'top items in a store')) battery.workingShapes.push({ label: 'top items in a store', shape: { ...pinned.shape, where: [['storeId', '==', '<storeId>']], dataContractId: '<contractId>' } });
  }
  await battery.checkRanked('s8f most-reviewed items carries item one at 2', 'itemReview', 'itemId', ctx.item1, 2);

  const havingShape = { dataContractId: ctx.contractId, documentTypeName: 'itemReview', groupBy: 'itemId', aggregate: { type: 'avg', property: 'rating' }, having: { operator: '>=', value: 3 }, direction: 'desc', limit: 100 };
  const having = await battery.readback(() => battery.sdk.documents.having(havingShape));
  const ids = having.entries.map((entry) => entry.groupValue);
  const item1Avg = sum(ctx.itemRatings[ctx.item1]) / ctx.itemRatings[ctx.item1].length;
  battery.check('s8g HAVING avg >= 3 includes item two (3.0) and includes item one iff its average is >= 3', ids.includes(ctx.item2) && (item1Avg >= 3) === ids.includes(ctx.item1), `ids=${ids.length} item1Avg=${item1Avg} item1In=${ids.includes(ctx.item1)} item2In=${ids.includes(ctx.item2)}`);
  battery.workingShapes.push({ label: 'items rated >= 3 (having)', shape: { ...havingShape, dataContractId: '<contractId>' } });
}

async function caseS9OrderCounts(ctx) {
  const { battery } = ctx;
  console.log('\n--- s9. order counts + most-ordered stores ---');
  const [buyerCount, sellerCount, storeCount] = await Promise.all([
    battery.countBy('storeOrder', [['$ownerId', '==', ctx.buyer.ownerId]]),
    battery.countBy('storeOrder', [['sellerId', '==', ctx.seller.ownerId]]),
    battery.countBy('storeOrder', [['storeId', '==', ctx.storeId]]),
  ]);
  battery.check("s9a buyer/seller/store order counts agree; the store count grew by this run's 2 orders", buyerCount >= 2 && sellerCount === storeCount && storeCount - ctx.baseline.orders === 2, `buyer=${buyerCount} seller=${sellerCount} store=${storeCount} baseline=${ctx.baseline.orders}`);
  const most = await battery.checkRanked('s9b most-ordered stores ranking carries our store at the proved count', 'storeOrder', 'storeId', ctx.storeId, storeCount);
  if (most) battery.workingShapes.push({ label: 'most ordered stores', shape: { ...most.shape, dataContractId: '<contractId>' } });
}

async function caseS10Composite(ctx) {
  const { battery } = ctx;
  console.log('\n--- s10. composite: store page and orders page in one proof each ---');
  const storeSubQueries = [{ documentType: 'itemReview', kind: 'counts', bind: { sourceProperty: '$id', field: 'itemId' } }, { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } }];
  try {
    const page = await battery.readback(() => battery.sdk.documents.composite({ dataContractId: ctx.contractId, documentType: 'storeItem', where: [['storeId', '==', ctx.storeId]], orderBy: [['$createdAt', 'asc']], limit: 20, subQueries: storeSubQueries }));
    const counts = page.subResults[0]?.kind === 'counts' ? page.subResults[0].counts : new Map();
    const stores = page.subResults[1]?.kind === 'documents' ? page.subResults[1].documents : [];
    // Count maps are keyed by hex-encoded index key (the bound identifier's bytes).
    const countFor = (id) => counts.get(id) ?? counts.get(Buffer.from(bs58.decode(id)).toString('hex'));
    battery.check('s10a store page composite: items + per-item review counts + store join', page.pageDocuments.length >= 2 && Number(countFor(ctx.item1) ?? 0n) === 2 && Number(countFor(ctx.item2) ?? 0n) === 1 && stores.length === 1, `items=${page.pageDocuments.length} c1=${countFor(ctx.item1)} c2=${countFor(ctx.item2)} stores=${stores.length}`);
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

async function caseS12Tokens(ctx) {
  const { battery } = ctx;
  console.log('\n--- s12. YAPP accounting ---');
  const after = await battery.yappBalance(ctx.tokenId, ctx.buyer.ownerId);
  const spent = ctx.buyerYappBefore - after;
  const expected = BigInt(ctx.reviews.length) * REVIEW_COST.storeReview + BigInt(Object.values(ctx.itemRatings ?? {}).flat().length) * REVIEW_COST.itemReview;
  battery.check('s12a buyer YAPP dropped by exactly the accepted review costs (rejected writes charge no tokens)', spent === expected, `before=${ctx.buyerYappBefore} after=${after} spent=${spent} expected=${expected}`);
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

const CASES = new Map([
  ['s1', caseS1Fixtures], ['s2', caseS2ItemRefs], ['s3', caseS3Orders], ['s4', caseS4Status],
  ['s5', caseS5StoreReviews], ['s6', caseS6ItemReviews], ['s7', caseS7Averages], ['s8', caseS8Rankings],
  ['s9', caseS9OrderCounts], ['s10', caseS10Composite], ['s11', caseS11Permanence], ['s12', caseS12Tokens],
  ['s13', caseS13Immutable], ['s14', caseS14Ban], ['s15', caseS15ModeratorDelete],
]);

await runBattery({
  label: 'storefront',
  contract: { env: 'STOREFRONT_CONTRACT_ID' },
  cases: CASES,
  actors: { seller: 200, buyer: 201, stranger: 202, moderator: 203 },
  yapp: { default: DEFAULT_YAPP, actors: ['buyer', 'stranger'], require: true },
  banner: ({ socialId }) => `; YAPP from ${socialId}`,
  selfTest: () => {
    // s2d/s2e + s13: only the store owner may list under a store, and never move it.
    const ownedByStoreOwner = { agreements: { storeId: { $ownerId: '$ownerId' } }, immutable: ['storeId'] };
    return selfTestModerated('yappr-storefront-contract.json', {
      storeItem: ownedByStoreOwner,
      shippingZone: ownedByStoreOwner,
      // s3d: sellerId is the store's real owner, not a buyer's claim.
      storeOrder: { agreements: { storeId: { sellerId: '$ownerId' } } },
      // s4d/s4e: only the seller posts status updates.
      orderStatusUpdate: { agreements: { orderId: { buyerId: '$ownerId', $ownerId: 'sellerId' } } },
      // s5c/s6: only the identity that placed the order may review it.
      // s15/s16: reviews are the moderator-deletable types; nothing references them.
      storeReview: { agreements: { orderId: { storeId: 'storeId', sellerId: 'sellerId', $ownerId: '$ownerId' } }, moderatorDeletable: true },
      itemReview: { agreements: { itemId: { storeId: 'storeId' }, orderId: { storeId: 'storeId', $ownerId: '$ownerId' } }, moderatorDeletable: true },
      store: { moderatorDeletable: false },
    }, { moderation: { banlist: true, suspensions: true } });
  },
  setup: async ({ battery, tokenId, buyer, moderator }) => ({ reviews: [], itemRatings: {}, zoneId: null, buyerYappBefore: await battery.yappBalance(tokenId, buyer.ownerId), moderator: { ...moderator, identity: await battery.readback(() => battery.sdk.identities.fetch(moderator.ownerId)) } }),
  summary: (ctx) => `store=${ctx.storeId} items=${ctx.item1},${ctx.item2} orders=${ctx.orderId},${ctx.orderId2}`,
});
