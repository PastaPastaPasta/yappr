#!/usr/bin/env node
/** Read-only equivalence probes against the deployed devnet. No signing keys.
 * NETWORK=devnet V10_CONTRACT_ID=<social contract id (v10, v11 or v12)> node scripts/verify-social-query-bundles.mjs [report.json]
 * Counts document facade requests after connection/contract warm-up, not HTTP
 * retries, subqueries, quorum reads, or complete rendered-screen traffic.
 *
 * Social v10 has no repost type: a repost is a post quoting its target with no
 * content, so it notifies through post.quotedPostOwnerRecent, sits in its
 * author's own post pages, and the quote count is the repost count. Per-reply
 * counts pin the root (repliesOf [rootPostId, replyToReplyId, $createdAt]).
 *
 * Notification sources: follows, mentions (post.mentionedUserAndTime and
 * reply.mentionedUserAndTime) and follow requests are permanent and bundle;
 * replies (reply.parentOwnerRecent) and quotes/reposts
 * (post.quotedPostOwnerRecent) sit on non-overlapping 3.5-day windows kept a
 * week, read through the `timeRange` option (the current window, `newest`, and
 * the previous one by its start, `byStart`), which a composite refuses, so each
 * window stays one plain query.
 * Likes are permanent but keyed by target: on v10 byAuthorPostTime /
 * byAuthorReplyTime put the liked post or reply before `$createdAt`, so "who
 * liked it since" is one `target in [recent]` read per kind. v11's author
 * indexes keep no time: one author-pinned `target in [recent]` liker read per
 * kind. On v12 they are counters (`summableOffCountIndex` of byPost /
 * byReply) holding no like documents: the counters must agree with byPost /
 * byReply per target, and the likers are read one target at a time on byPost /
 * byReply. What the contract under test declares (fetched by id, not the
 * environment's topology) picks the like reads and the notification grids.
 * There is no postMention: a post or reply names at most one mentionedUserId. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import bs58 from 'bs58';
import { PlatformVersion } from '@dashevo/evo-sdk';
import { connectSdk, devnetName, envValue } from './sdk-env.mjs';

const social = process.env.V10_CONTRACT_ID;
if (!social) {
  console.error('Set V10_CONTRACT_ID to the social contract under test, a v10, v11 or v12 cut (there is no default).');
  process.exit(1);
}
/** A contract id from the environment or `.env.devnet`; the devnet's own, never a baked-in chain's. */
function contractId(name) {
  const value = envValue(name);
  if (!value) {
    console.error(`Set ${name} (environment or .env.devnet) to the devnet's contract id.`);
    process.exit(1);
  }
  return value;
}
// v10 retires the profile contract: the base profile is DashPay's `profile`
// (a system contract, the same id on every chain), keyed by its owner.
const profile = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7';
const dpns = envValue('NEXT_PUBLIC_DPNS_CONTRACT_ID') || 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const dm = contractId('NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID');
const blog = contractId('NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID');
const sdk = await connectSdk({ net: 'devnet', timeoutMs: 20000 });
await sdk.contracts.fetch(dpns);
await sdk.contracts.getMany([social, profile, dm, blog]);

const records = response => Array.from(response.values()).filter(Boolean).map(doc => doc.toObject());
const id = bytes => typeof bytes === 'string' ? bytes : bs58.encode(bytes);
// The synthetic id of an indexOnly document is not stable across surfaces.
const canonical = docs => JSON.stringify(docs.map(doc => Object.fromEntries(
  Object.entries(doc).filter(([key]) => key !== '$id').sort(([a], [b]) => a.localeCompare(b))
)), (_, value) => typeof value === 'bigint' ? value.toString() : value);
const timeline = records(await sdk.documents.query({
  dataContractId: social, documentTypeName: 'post',
  where: [['$createdAt', '>', 0]],
  orderBy: [['$createdAt', 'desc']], limit: 20,
}));
assert(timeline.length, 'Need public posts to exercise nonempty queries');
const owner = id(timeline[0].$ownerId);
const owners = [...new Set(timeline.map(doc => id(doc.$ownerId)))].slice(0, 4);
const reports = [];

async function verify(name, queries) {
  try {
    const before = [];
    for (const query of queries) {
      // The old blog/message readers omitted the timestamp range. Confirm that
      // narrowing to consensus-created documents preserves their exact pages.
      const baseline = /blog pages|conversation messages/.test(name)
        ? { ...query, where: query.where?.filter(clause => !(clause[0] === '$createdAt' && clause[1] === '>' && clause[2] === 0)) }
        : query;
      before.push(records(await sdk.documents.query(baseline)));
    }
    const [page, ...siblings] = queries;
    const result = await sdk.documents.composite({
      dataContractId: page.dataContractId, documentType: page.documentTypeName,
      where: page.where, orderBy: page.orderBy, limit: page.limit,
      subQueries: siblings.map(query => ({
        dataContractId: query.dataContractId, documentType: query.documentTypeName,
        where: query.where, orderBy: query.orderBy, limit: query.limit,
      })),
    });
    assert.equal(result.subResults.length, siblings.length);
    const after = [result.pageDocuments, ...result.subResults.map(sub => {
      assert.equal(sub.kind, 'documents');
      return sub.documents;
    })].map(docs => docs.map(doc => doc.toObject()));
    before.forEach((docs, i) => assert.equal(canonical(after[i]), canonical(docs), `${name} member ${i}`));
    reports.push({ name, before: queries.length, after: 1, rows: before.map(docs => docs.length), equivalent: true });
    console.log(`PASS ${name}: ${queries.length} → 1; rows ${before.map(docs => docs.length).join(',')}`);
  } catch (error) {
    const message = String(error.message || error.reason || error.toJSON?.() || JSON.stringify(error));
    reports.push({ name, equivalent: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

await verify('profiles and DPNS including profile-less identity', [
  { dataContractId: profile, documentTypeName: 'profile', where: [['$ownerId', 'in', [...owners, '1'.repeat(32)]]], orderBy: [['$ownerId', 'asc']], limit: owners.length + 1 },
  { dataContractId: dpns, documentTypeName: 'domain', where: [['records.identity', 'in', [...owners, '1'.repeat(32)]]], orderBy: [['records.identity', 'asc']], limit: 100 },
]);
// Mentions stay permanent (the mentioning post's and reply's own mentionedUserAndTime).
await verify('permanent notification sources', [['follow', 'followingId'], ['post', 'mentionedUserId'], ['reply', 'mentionedUserId'], ['followRequest', 'targetId']].map(([documentTypeName, field]) => ({
  dataContractId: social, documentTypeName,
  where: [[field, '==', owner], ['$createdAt', '>', 0]],
  orderBy: [[field, 'asc'], ['$createdAt', 'desc']], limit: 100,
})));

/** The social contract under test as published (v10, v11 or v12): its declarations pick the reads below. */
const V10 = (await sdk.contracts.fetch(social)).toJSON(PlatformVersion.latest());
/** v10: the author index carries `$createdAt` after the target (byAuthorPostTime). */
const LIKES_KEEP_TIME = V10.documentSchemas.like.indices.some(index => index.name === 'byAuthorPostTime');
/** v12: the author indexes are counters of byPost / byReply (no like documents through them). */
const LIKE_COUNTERS = V10.documentSchemas.like.indices.some(index => index.summableOffCountIndex !== undefined);
/**
 * The current and the previous window of `documentTypeName`'s windowed
 * notification index, the grid named (like and post bucket $createdAt on
 * several). The node's `oldest` is the oldest window still containing now,
 * the current one on this non-overlapping grid, so the previous window is
 * named by its start.
 */
function windowsOf(documentTypeName, indexName) {
  const { range, step } = V10.documentSchemas[documentTypeName].indices.find(index => index.name === indexName).timeRange;
  const stepMs = step * 1000;
  const previousStart = (Math.floor(Date.now() / stepMs) - 1) * stepMs;
  return [{ selector: 'newest' }, { selector: 'byStart', startMs: previousStart }].map(pick => [{ field: '$createdAt', ...pick, grid: { range, step } }]);
}
/** Sources that do not ride a composite (windowed, or one read per target): each is read alone, and only its success is asserted. */
async function verifyAlone(name, queries) {
  try {
    const rows = [];
    for (const query of queries) rows.push(records(await sdk.documents.query(query)).length);
    reports.push({ name, before: queries.length, after: queries.length, rows, equivalent: true });
    console.log(`PASS ${name}: ${queries.length} plain queries; rows ${rows.join(',')}`);
  } catch (error) {
    const message = String(error.message || error.reason || error.toJSON?.() || JSON.stringify(error));
    reports.push({ name, equivalent: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}
await verifyAlone('notification windows (current and previous)', [
  ['reply', 'parentOwnerRecent', 'parentOwnerId'], ['post', 'quotedPostOwnerRecent', 'quotedPostOwnerId'],
].flatMap(([documentTypeName, indexName, field]) => windowsOf(documentTypeName, indexName).map(timeRange => ({
  dataContractId: social, documentTypeName,
  where: [[field, '==', owner]], timeRange, limit: 100,
}))));
// "Liked your post / reply": the likes of the owner's twenty most recent posts
// and replies since the start, newest first, one `target in` read per kind.
const recentOwn = async (documentTypeName) => records(await sdk.documents.query({
  dataContractId: social, documentTypeName, where: [['$ownerId', '==', owner], ['$createdAt', '>', 0]],
  orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20,
}));
const likesSince = (documentTypeName, author, target, docs) => ({
  dataContractId: social, documentTypeName,
  where: [[author, '==', owner], [target, 'in', docs.map(doc => id(doc.$id))], ['$createdAt', '>', 0]],
  orderBy: [[author, 'asc'], [target, 'asc'], ['$createdAt', 'desc']], limit: 100,
});
const [ownPosts, ownReplies] = [await recentOwn('post'), await recentOwn('reply')];
const likeKinds = [['like', 'postAuthor', 'postId', ownPosts], ['likeReply', 'replyAuthor', 'replyId', ownReplies]].filter(([, , , docs]) => docs.length);
if (LIKES_KEEP_TIME) {
  await verifyAlone('like notifications (one target-in read per kind)', likeKinds.map(([type, author, target, docs]) => likesSince(type, author, target, docs)));
} else if (!LIKE_COUNTERS) {
  // v11: the author index keeps no time; one author-pinned liker read per kind, diffed on the device.
  await verifyAlone('like notifications (one author-pinned target-in liker read per kind, no time)', likeKinds.map(([documentTypeName, author, target, docs]) => ({
    dataContractId: social, documentTypeName,
    where: [[author, '==', owner], [target, 'in', docs.map(doc => id(doc.$id))]],
    orderBy: [[author, 'asc'], [target, 'asc']], limit: 100,
  })));
} else {
  // v12: the counters answer "did my likes move" per target; the likers come off byPost / byReply.
  for (const [documentTypeName, author, target, docs] of likeKinds) await verifyCounters(documentTypeName, author, target, docs);
  await verifyAlone('like notifications (the likers of each target on byPost / byReply, one read per target)', likeKinds.flatMap(([documentTypeName, , target, docs]) => docs.slice(0, 5).map(doc => ({
    dataContractId: social, documentTypeName,
    where: [[target, '==', id(doc.$id)]], orderBy: [[target, 'asc'], ['$ownerId', 'asc']], limit: 100,
  }))));
}

/** v12: the author counter of each of the owner's recent targets equals the target index's own count. */
async function verifyCounters(documentTypeName, author, target, docs) {
  const name = `${documentTypeName} author counters agree with the target index`;
  try {
    const ids = docs.map(doc => id(doc.$id));
    const [counters, sources] = await Promise.all([
      sdk.documents.count({ dataContractId: social, documentTypeName, where: [[author, '==', owner], [target, 'in', ids]], groupBy: [target] }),
      sdk.documents.count({ dataContractId: social, documentTypeName, where: [[target, 'in', ids]], groupBy: [target] }),
    ]);
    for (const targetId of ids) {
      const hex = Buffer.from(bs58.decode(targetId)).toString('hex');
      assert.equal(Number(counters.get(hex) ?? 0), Number(sources.get(hex) ?? 0), `${targetId}`);
    }
    reports.push({ name, before: 2, after: 2, rows: ids.length, equivalent: true });
    console.log(`PASS ${name}: ${ids.length} targets`);
  } catch (error) {
    const message = String(error.message || error.reason || error.toJSON?.() || JSON.stringify(error));
    reports.push({ name, equivalent: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}
// A followed author's reposts are posts: their own post pages carry them.
await verify('following post pages (reposts included)', owners.map(ownerId => ({
  dataContractId: social, documentTypeName: 'post',
  where: [['$ownerId', '==', ownerId], ['$createdAt', '>', 0]],
  orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 100,
})));

const blogs = records(await sdk.documents.query({ dataContractId: blog, documentTypeName: 'blog', limit: 3 }));
const blogIds = blogs.map(doc => id(doc.$id));
while (blogIds.length < 2) blogIds.push(bs58.encode(Uint8Array.from({ length: 32 }, () => blogIds.length + 1)));
await verify('blog pages with separate row budgets', blogIds.map(blogId => ({
  dataContractId: blog, documentTypeName: 'blogPost', where: [['blogId', '==', blogId], ['$createdAt', '>', 0]],
  orderBy: [['blogId', 'asc'], ['$createdAt', 'desc']], limit: 10,
})));

const invites = records(await sdk.documents.query({ dataContractId: dm, documentTypeName: 'conversationInvite', limit: 4 }));
const conversationIds = [...new Set(invites.map(doc => Buffer.from(doc.conversationId).toString('base64')))];
while (conversationIds.length < 2) conversationIds.push(Buffer.alloc(10, conversationIds.length + 1).toString('base64'));
await verify('conversation messages and owner receipts', [
  ...conversationIds.map(conversationId => ({
    dataContractId: dm, documentTypeName: 'directMessage', where: [['conversationId', '==', conversationId], ['$createdAt', '>', 0]],
    orderBy: [['$createdAt', 'asc']], limit: 100,
  })),
  { dataContractId: dm, documentTypeName: 'readReceipt', where: [['$ownerId', '==', owner], ['conversationId', 'in', conversationIds]], orderBy: [['conversationId', 'asc']], limit: conversationIds.length },
]);

await verify('blog comment count pages', timeline.slice(0, 2).map(doc => ({
  dataContractId: blog, documentTypeName: 'blogComment',
  where: [['blogPostId', '==', id(doc.$id)], ['$createdAt', '>', 0]],
  orderBy: [['blogPostId', 'asc'], ['$createdAt', 'asc']], limit: 100,
})));

/** The root of a thread with direct replies, for the reply page (per-reply counts pin the root). */
async function threadRoot() {
  for (const doc of timeline) {
    const rootPostId = id(doc.$id);
    const direct = await sdk.documents.count({ dataContractId: social, documentTypeName: 'reply',
      where: [['rootPostId', '==', rootPostId], ['replyToReplyId', '==', null]] });
    if (Number(direct.get('') ?? 0) > 0) return rootPostId;
  }
  return id(timeline[0].$id);
}

async function verifyEnrichment(kind) {
  const name = `${kind} composite enrichment counts and viewer marks`;
  try {
    // A post page is an author's posts; a reply page is a thread's direct replies
    // (the page the thread view counts children on, under its root). The reply
    // composite is by id, as load-post-enrichment sends it: a repliesOf page with
    // a repliesOf count slot is refused ("lands at the merged root").
    const root = kind === 'reply' ? await threadRoot() : null;
    const pageQuery = kind === 'post'
      ? { dataContractId: social, documentTypeName: kind,
        where: [['$ownerId', '==', owner], ['$createdAt', '>', 0]],
        orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20 }
      : { dataContractId: social, documentTypeName: kind,
        where: [['rootPostId', '==', root], ['replyToReplyId', '==', null]],
        orderBy: [['$createdAt', 'asc']], limit: 20 };
    const page = records(await sdk.documents.query(pageQuery));
    const ids = page.map(doc => id(doc.$id));
    const targetField = kind === 'post' ? 'postId' : 'replyId';
    const likeType = kind === 'post' ? 'like' : 'likeReply';
    // [documentType, bound field, fixed where]; the quote count is the repost count.
    const countSources = [[likeType, targetField, []],
      kind === 'post' ? ['reply', 'rootPostId', []] : ['reply', 'replyToReplyId', [['rootPostId', '==', root]]],
      ['post', kind === 'post' ? 'quotedPostId' : 'quotedReplyId', []]];
    const subQueries = countSources.map(([documentType, field, where]) => ({
      documentType, kind: 'counts', ...(where.length ? { where } : {}), bind: { source: 'page', sourceProperty: '$id', field },
    }));
    // The viewer marks ride byPost / byReply ([target] terminal $ownerId), the slot's limit the page size.
    subQueries.push({ documentType: likeType, where: [['$ownerId', '==', owner]],
      bind: { source: 'page', sourceProperty: '$id', field: targetField }, limit: 20 });
    if (kind === 'reply' && ids.length === 0) throw new Error('the thread root has no direct replies to page');
    const byId = (docs) => [...docs].sort((a, b) => id(a.$id).localeCompare(id(b.$id)));
    const result = kind === 'post'
      ? await sdk.documents.composite({
        dataContractId: social, documentType: kind, where: pageQuery.where,
        orderBy: pageQuery.orderBy, limit: 20, subQueries,
      })
      : await sdk.documents.composite({
        dataContractId: social, documentType: kind, where: [['$id', 'in', ids]], limit: ids.length, subQueries,
      });
    assert.equal(canonical(byId(result.pageDocuments.map(doc => doc.toObject()))), canonical(byId(page)));
    for (let i = 0; i < countSources.length; i++) {
      const [documentTypeName, field, where] = countSources[i];
      const counts = ids.length ? await sdk.documents.count({ dataContractId: social,
        documentTypeName, where: [...where, [field, 'in', ids]], groupBy: [field] }) : new Map();
      for (const postId of ids) {
        const hex = Buffer.from(bs58.decode(postId)).toString('hex');
        assert.equal(Number(result.subResults[i].counts.get(postId) ?? 0), Number(counts.get(hex) ?? 0));
      }
    }
    const marks = ids.length ? records(await sdk.documents.query({ dataContractId: social,
      documentTypeName: likeType, where: [[targetField, 'in', ids], ['$ownerId', '==', owner]],
      orderBy: [[targetField, 'asc'], ['$ownerId', 'asc']], limit: ids.length })) : [];
    const byTarget = docs => [...docs].sort((a, b) => id(a[targetField]).localeCompare(id(b[targetField])));
    assert.equal(canonical(byTarget(result.subResults.at(-1).documents.map(doc => doc.toObject()))), canonical(byTarget(marks)));
    reports.push({ name, before: 2 + countSources.length, after: 1, rows: page.length, equivalent: true });
    console.log(`PASS ${name}; ${page.length} page rows`);
  } catch (error) {
    const message = String(error.message || JSON.stringify(error));
    reports.push({ name, equivalent: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}
await verifyEnrichment('post');
await verifyEnrichment('reply');

const report = { at: new Date().toISOString(), network: devnetName(), baseline: '4105c5d1', reports };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
process.exit(reports.every(result => result.equivalent) ? 0 : 1);
