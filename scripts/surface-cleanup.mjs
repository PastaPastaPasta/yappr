/**
 * Takes down what the blog, storefront and pollr batteries (and their personas
 * run by hand) wrote on the PUBLISHED feature contracts since a point in time,
 * each document by the means its contract allows:
 *
 *   blog        comments and follows: the owner's delete. Posts and drafts:
 *               the author's tombstone (`blogPost` is canBeDeleted false), the
 *               client's own delete: `deleted`, comments off, blogId/slug/
 *               publishedAt kept. A `blog` cannot be deleted by its owner: it
 *               goes only by a moderator's removal, and only when the caller
 *               runs with a moderator (`moderator`); otherwise a leftover.
 *   storefront  store and item reviews, digital kits and shipping zones: the
 *               owner's delete. Items: `status: 'deleted'`, the client's own
 *               delete (`storeItem` is canBeDeleted false). Stores created in
 *               the window are closed: `store` is unique per owner and cannot
 *               be deleted, and the app lists active stores only. A store the
 *               run reopened (`reopened`) gets its earlier status back.
 *               Orders, their status updates and
 *               deliveries are permanent (canBeDeleted false, immutable): they
 *               are leftovers, encrypted and read only by their buyer and seller.
 *   pollr       a poll with no ballot: the owner's delete. A poll with one,
 *               even a withdrawn one, is permanent (`vote` is canBeDeleted
 *               false and `noBallots` counts withdrawn ballots): a leftover.
 *               The pollr battery runs on its test contract by default, so
 *               this is for `--live-contract` runs and hand cleanups.
 *
 * Only documents created at or after `since` and owned by `owners` are touched
 * (blogs and stores of the owners are read whatever their age, since a new
 * post or item may sit on an older one). Every write is judged by reading it
 * back (battery-lib). Anything that cannot be removed is reported as a
 * leftover, never worked around. Idempotent: a second run finds nothing to do.
 *
 * Used by verify-blog / verify-storefront / verify-pollr (their runBattery
 * `cleanup`) and by scripts/clean-test-content.mjs `--surface`. Prints no key
 * material.
 */
import bs58 from 'bs58';
import { normalizeId } from './battery-lib.mjs';
import { describeErr } from './owner-keys.mjs';

/** The surfaces scripts/clean-test-content.mjs cleans: the social timeline (test-content-cleanup.mjs) and these. */
export const SURFACES = ['social', 'blog', 'storefront', 'pollr'];
/** Each feature surface's published contract, as the deployment's env file names it. */
export const SURFACE_CONTRACT_ENV = {
  blog: 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID',
  storefront: 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID',
  pollr: 'NEXT_PUBLIC_POLLR_CONTRACT_ID',
};

const PAGE = 100;
const MAX_PAGES = 50;

// ---- Pure shapes ---------------------------------------------------------------

/**
 * `value` with every integer as a Number, the way the client and the batteries
 * write them (`Document.toObject()` hands them back as BigInt); bytes and
 * lists are kept. An integer past 2^53 stays a BigInt.
 */
function plainNumbers(value) {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value;
  if (Array.isArray(value)) return value.map(plainNumbers);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainNumbers(entry)]));
  return value;
}

/** A stored document's content as a replace resends it: its data without the `$` system fields (nor absent ones). */
export function contentOf(stored) {
  return plainNumbers(Object.fromEntries(Object.entries(stored).filter(([key, value]) => !key.startsWith('$') && value !== undefined)));
}

/** Of `rows`, those owned by an id in `owners` (a Set) and created at or after `since` (ms). */
export function createdSince(rows, { owners, since }) {
  return rows.filter((row) => owners.has(normalizeId(row.$ownerId)) && Number(row.$createdAt) >= since);
}

/**
 * The author's tombstone of a stored blog post (blog v8 `tombstoneIsBlank`):
 * `deleted`, comments off, every content field absent, and the frozen
 * `blogId` / `publishedAt` (a draft has none) and the required `slug` resent.
 */
export function blogPostTombstone(stored) {
  const blogId = typeof stored.blogId === 'string' ? bs58.decode(stored.blogId) : Uint8Array.from(stored.blogId);
  return {
    deleted: true, commentsEnabled: false, blogId, slug: stored.slug,
    ...(stored.publishedAt === undefined || stored.publishedAt === null ? {} : { publishedAt: plainNumbers(stored.publishedAt) }),
  };
}

/** A stored document with `status` set, every other field resent as stored: the item's delete, the store's close. */
export const withStatus = (stored, status) => ({ ...contentOf(stored), status });

// ---- Reads and writes ------------------------------------------------------------

/** Every page of a read (newest pages stop at MAX_PAGES × PAGE documents). */
async function queryAll(battery, docType, where, orderBy) {
  const rows = [];
  let startAfter;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await battery.queryDocs(docType, { where, orderBy, limit: PAGE, ...(startAfter ? { startAfter } : {}) });
    rows.push(...batch);
    if (batch.length < PAGE) break;
    startAfter = normalizeId(batch.at(-1).$id);
  }
  return rows;
}

/** `rows` without repeats of a document (the same `$id` read through two indexes). */
const distinctDocs = (rows) => [...new Map(rows.map((row) => [normalizeId(row.$id), row])).values()];

/** One read per item, flattened (sequential: the devnet's DAPI is easily overrun). */
async function readEach(items, read) {
  const rows = [];
  for (const item of items) rows.push(...await read(item));
  return rows;
}

/**
 * @typedef {object} CleanupReport
 * @property {string} surface
 * @property {'live' | 'plan'} mode
 * @property {Record<string, number>} found per type, what the window holds
 * @property {Record<string, number>} done per action, what was (in a plan: would be) removed
 * @property {Array<{ type: string, id?: string, count?: number, name?: string, why: string }>} leftovers what cannot be removed
 * @property {Array<{ label: string, id: string, error: string }>} failed what could not be removed this time
 */

/**
 * @typedef {object} Owner a document owner; a live run needs its keys (battery-lib personaActor)
 * @property {string} ownerId
 * @property {string} label
 */

/**
 * The report a cleanup fills: what it found and did per type (`done`; in a
 * plan, what it would do), what cannot be removed (`leftovers`) and what
 * failed (`failed`).
 * @returns {CleanupReport}
 */
function newReport(surface, live) {
  return { surface, mode: live ? 'live' : 'plan', found: {}, done: {}, leftovers: [], failed: [] };
}

/** `targets` (type → rows) as type → how many. */
const countsOf = (targets) => Object.fromEntries(Object.entries(targets).map(([type, rows]) => [type, rows.length]));

/**
 * Applies `write(row, id)` (→ battery outcome `{ ok, error }`) to each row,
 * counting it under `label`; a plan only counts.
 */
async function applyEach(report, live, rows, label, write) {
  const counted = () => { report.done[label] = (report.done[label] ?? 0) + 1; };
  for (const row of rows) {
    const id = normalizeId(row.$id);
    if (!live) { counted(); continue; }
    const outcome = await write(row, id).catch((e) => ({ ok: false, error: describeErr(e) }));
    if (outcome.ok) counted();
    else report.failed.push({ label, id, error: (outcome.error ?? 'not confirmed').slice(0, 200) });
  }
}

/** The owner's delete of each `types` row in `targets`. */
async function deleteEach({ report, live, battery, owners, targets, types }) {
  for (const type of types) {
    await applyEach(report, live, targets[type], type, (row, id) => battery.attemptDelete(ownerOf(owners, row), type, id));
  }
}

/** A moderator's removal of `docType` `id`, judged by the document no longer reading back. */
function moderatorRemove(battery, { contractId, moderator, docType, id, reason }) {
  return battery.attemptWrite(
    { accepted: async () => (await battery.fetchDocument(docType, id)) === null },
    () => battery.sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: docType, documentId: id, reason: { text: reason }, signer: moderator.signer }),
  );
}

/** The signing actor among `owners` for a row; a plan's owners need no keys. */
const ownerOf = (owners, row) => owners.find((who) => who.ownerId === normalizeId(row.$ownerId));
const ownerSet = (owners) => new Set(owners.map((who) => who.ownerId));
const notTombstone = (row) => row.deleted !== true;

/**
 * Cleans the blog contract (`battery` is bound to it, `contractId` is its id).
 * `owners`: `{ ownerId, label, identityKey?, signer? }` (keys only for a live
 * run); `moderator`: a battery moderatorActor, or null to leave new blogs up.
 * @param {{ battery: object, contractId: string, owners: Owner[], since: number, moderator?: { label: string } | null, live: boolean }} args
 * @returns {Promise<CleanupReport>}
 */
export async function cleanBlog({ battery, contractId, owners, since, moderator = null, live }) {
  const report = newReport('blog', live);
  const blogs = await readEach(owners, (who) => queryAll(battery, 'blog', [['$ownerId', '==', who.ownerId]], [['$ownerId', 'asc'], ['$createdAt', 'asc']]));
  // Only a blog's owner posts to it (b21), so the owners' posts are the posts on their blogs.
  const posts = await readEach(blogs, (blog) => queryAll(battery, 'blogPost', [['blogId', '==', normalizeId(blog.$id)], ['$createdAt', '>=', since]], [['blogId', 'asc'], ['$createdAt', 'asc']]));
  // blogComment keeps no owner index, so the owners' comments are found through every post author's
  // postOwnerAndTime from `since` (the authors from the blogPost timeline), then kept by owner below:
  // an owner's comment on anyone's post, not only on the owners' own.
  const authors = new Set((await queryAll(battery, 'blogPost', [['$createdAt', '>', 0]], [['$createdAt', 'asc']])).map((row) => normalizeId(row.$ownerId)));
  for (const who of owners) authors.add(who.ownerId);
  const comments = await readEach([...authors], (author) => queryAll(battery, 'blogComment', [['blogPostId.$ownerId', '==', author], ['$createdAt', '>=', since]], [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'asc']]));
  const follows = await readEach(owners, (who) => queryAll(battery, 'blogFollow', [['$ownerId', '==', who.ownerId]], [['$ownerId', 'asc'], ['blogId', 'asc']]));
  const scope = { owners: ownerSet(owners), since };
  const targets = {
    blogComment: createdSince(comments, scope),
    blogFollow: createdSince(follows, scope),
    blogPost: createdSince(posts, scope).filter(notTombstone),
    blog: createdSince(blogs, scope),
  };
  report.found = countsOf(targets);

  await deleteEach({ report, live, battery, owners, targets, types: ['blogComment', 'blogFollow'] });
  await applyEach(report, live, targets.blogPost, 'blogPost (tombstone)', (row, id) => battery.attemptReplace(ownerOf(owners, row), 'blogPost', id, blogPostTombstone(row), row.$revision));
  if (!moderator) {
    for (const row of targets.blog) report.leftovers.push({ type: 'blog', id: normalizeId(row.$id), name: row.name, why: 'a blog cannot be deleted by its owner; run with a moderator to remove it' });
    return report;
  }
  await applyEach(report, live, targets.blog, `blog (removed by ${moderator.label})`, (row) => moderatorRemove(battery, { contractId, moderator, docType: 'blog', id: normalizeId(row.$id), reason: 'test fixture of the blog battery' }));
  return report;
}

/**
 * Cleans the storefront contract. `reopened`: the stores the run reopened, as
 * `[id, status before]` entries (a Map), which get that status back; a store
 * created in the window is closed.
 * @param {{ battery: object, owners: Owner[], since: number, reopened?: Map<string, string>, live: boolean }} args
 * @returns {Promise<CleanupReport>}
 */
export async function cleanStorefront({ battery, owners, since, reopened = new Map(), live }) {
  const report = newReport('storefront', live);
  const scope = { owners: ownerSet(owners), since };
  const stores = await readEach(owners, (who) => battery.queryDocs('store', { where: [['$ownerId', '==', who.ownerId]], limit: 1 }));
  const inWindow = (docType, index) => readEach(stores, (store) => queryAll(battery, docType, [[index, '==', normalizeId(store.$id)], ['$createdAt', '>=', since]], [[index, 'asc'], ['$createdAt', 'asc']]));
  const items = createdSince(await inWindow('storeItem', 'storeId'), scope);
  // The owners' own orders, at anyone's store (buyerOrders), and the reviews written on them (a review names
  // its order): with the reads under the owners' stores, every order and review an owner wrote in the window.
  const ownOrders = createdSince(await readEach(owners, (who) => queryAll(battery, 'storeOrder', [['$ownerId', '==', who.ownerId], ['$createdAt', '>=', since]], [['$ownerId', 'asc'], ['$createdAt', 'asc']])), scope);
  const reviewsOfOrder = (docType, index) => readEach(ownOrders, (order) => queryAll(battery, docType, [[index, '==', normalizeId(order.$id)]], [[index, 'asc']]));
  const itemReviews = distinctDocs([
    ...await readEach(items, (item) => queryAll(battery, 'itemReview', [['itemId', '==', normalizeId(item.$id)], ['$createdAt', '>=', since]], [['itemId', 'asc'], ['$createdAt', 'asc']])),
    ...await reviewsOfOrder('itemReview', 'orderId'),
  ]);
  const kits = await readEach(items, (item) => battery.queryDocs('itemDeliverable', { where: [['itemId', '==', normalizeId(item.$id)]], limit: 1 }));
  const zones = await readEach(stores, (store) => queryAll(battery, 'shippingZone', [['storeId', '==', normalizeId(store.$id)]], [['storeId', 'asc'], ['priority', 'asc']]));
  // Buyers among the owners: a real customer's order on a persona's store is not the run's.
  const orders = distinctDocs([...createdSince(await inWindow('storeOrder', 'storeId'), scope), ...ownOrders]);
  const restore = new Map(reopened);
  const statusAfter = (row) => restore.get(normalizeId(row.$id)) ?? (createdSince([row], scope).length > 0 ? 'closed' : null);
  const targets = {
    itemReview: createdSince(itemReviews, scope),
    storeReview: createdSince(distinctDocs([...await inWindow('storeReview', 'storeId'), ...await reviewsOfOrder('storeReview', 'orderId')]), scope),
    itemDeliverable: createdSince(kits, scope),
    shippingZone: createdSince(zones, scope),
    storeItem: items.filter((row) => row.status !== 'deleted'),
    store: stores.filter((row) => statusAfter(row) !== null && row.status !== statusAfter(row)),
  };
  report.found = { ...countsOf(targets), storeOrder: orders.length };

  await deleteEach({ report, live, battery, owners, targets, types: ['itemReview', 'storeReview', 'itemDeliverable', 'shippingZone'] });
  await applyEach(report, live, targets.storeItem, "storeItem (status 'deleted')", (row, id) => battery.attemptReplace(ownerOf(owners, row), 'storeItem', id, withStatus(row, 'deleted'), row.$revision));
  for (const status of new Set(targets.store.map(statusAfter))) {
    await applyEach(report, live, targets.store.filter((row) => statusAfter(row) === status), `store (status '${status}')`, (row, id) => battery.attemptReplace(ownerOf(owners, row), 'store', id, withStatus(row, status), row.$revision));
  }
  if (orders.length > 0) {
    report.leftovers.push({ type: 'storeOrder', count: orders.length, why: 'orders, their status updates and deliveries are permanent; encrypted, read only by their buyer and seller' });
  }
  return report;
}

/**
 * Cleans the pollr contract: the owners' polls without a ballot are deleted, the rest are leftovers.
 * @param {{ battery: object, owners: Owner[], since: number, live: boolean }} args
 * @returns {Promise<CleanupReport>}
 */
export async function cleanPollr({ battery, owners, since, live }) {
  const report = newReport('pollr', live);
  const read = await readEach(owners, (who) => queryAll(battery, 'poll', [['$ownerId', '==', who.ownerId], ['$createdAt', '>=', since]], [['$ownerId', 'asc'], ['$createdAt', 'asc']]));
  const polls = createdSince(read, { owners: ownerSet(owners), since });
  const deletable = [];
  for (const poll of polls) {
    const ballots = await battery.countBy('vote', [['pollId', '==', normalizeId(poll.$id)]]);
    if (ballots === 0) deletable.push(poll);
    else report.leftovers.push({ type: 'poll', id: normalizeId(poll.$id), name: poll.question, why: `${ballots} ballot(s): a ballot cannot be deleted, and noBallots counts withdrawn ones` });
  }
  report.found = { poll: polls.length };
  await applyEach(report, live, deletable, 'poll', (row, id) => battery.attemptDelete(ownerOf(owners, row), 'poll', id));
  return report;
}

/** Prints a report, one line per action, leftover and failure. True when nothing failed. */
export function printReport(report, log = console.log) {
  const verb = report.mode === 'live' ? 'removed' : 'would remove';
  log(`${report.surface}: found ${JSON.stringify(report.found)}`);
  for (const [label, count] of Object.entries(report.done)) log(`OK    ${report.surface}: ${verb} ${count} × ${label}`);
  for (const { type, id, count, name, why } of report.leftovers) log(`LEFT  ${report.surface}: ${type} ${id ?? `×${count}`}${name ? ` "${name}"` : ''} stays: ${why}`);
  // WARN, not FAIL: a cleanup never changes a battery's verdict, so its lines must not read as failed checks.
  for (const { label, id, error } of report.failed) log(`WARN  ${report.surface}: ${label} ${id} not removed: ${error}`);
  return report.failed.length === 0;
}
