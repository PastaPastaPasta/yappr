#!/usr/bin/env node
/** Read-only equivalence probes against the deployed devnet. No signing keys.
 * NETWORK=devnet V10_CONTRACT_ID=<social v10 id> node scripts/verify-social-query-bundles.mjs [report.json]
 * Counts document facade requests after connection/contract warm-up, not HTTP
 * retries, subqueries, quorum reads, or complete rendered-screen traffic.
 *
 * Social v10 has no repost type: a repost is a post quoting its target with no
 * content, so it notifies through post.quotedPostOwnerRecent, sits in its
 * author's own post pages, and the quote count is the repost count. Per-reply
 * counts pin the root (repliesOf [rootPostId, replyToReplyId, $createdAt]).
 *
 * Notification sources: follows, mentions (post.mentionedUserAndTime) and
 * follow requests are permanent and bundle; replies (reply.parentOwnerRecent)
 * and quotes/reposts (post.quotedPostOwnerRecent) are 7-day windows read
 * through the `timeRange` option, which a composite refuses, so each stays one
 * plain query. Likes are permanent but per target: byAuthorPostTime /
 * byAuthorReplyTime pin the liked post or reply before `$createdAt`, so "who
 * liked it since" is one plain read per recent post or reply. There is no
 * postMention: a post names at most one mentionedUserId. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import bs58 from 'bs58';
import { connectSdk, devnetName, envValue } from './sdk-env.mjs';

const social = process.env.V10_CONTRACT_ID;
if (!social) {
  console.error('Set V10_CONTRACT_ID to the social v10 contract under test (there is no default).');
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
// Mentions stay permanent (the mentioning post's own mentionedUserAndTime).
await verify('permanent notification sources', [['follow', 'followingId'], ['post', 'mentionedUserId'], ['followRequest', 'targetId']].map(([documentTypeName, field]) => ({
  dataContractId: social, documentTypeName,
  where: [[field, '==', owner], ['$createdAt', '>', 0]],
  orderBy: [[field, 'asc'], ['$createdAt', 'asc']], limit: 100,
})));

const V10 = JSON.parse(readFileSync(new URL('../contracts/yappr-social-contract-v10.json', import.meta.url), 'utf8'));
/** The oldest open window of `documentTypeName`'s windowed index, the grid named (like and post bucket $createdAt on several). */
function windowOf(documentTypeName, indexName) {
  const { range, step } = V10.documentSchemas[documentTypeName].indices.find(index => index.name === indexName).timeRange;
  return [{ field: '$createdAt', selector: 'oldest', grid: { range, step } }];
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
await verifyAlone('7-day notification windows', [
  ['reply', 'parentOwnerRecent', 'parentOwnerId'], ['post', 'quotedPostOwnerRecent', 'quotedPostOwnerId'],
].map(([documentTypeName, indexName, field]) => ({
  dataContractId: social, documentTypeName,
  where: [[field, '==', owner]], timeRange: windowOf(documentTypeName, indexName), limit: 100,
})));
// "Liked your post / reply": the likes of each of the owner's two most recent
// posts and replies since the start, newest first, one plain read per target.
const recentOwn = async (documentTypeName) => records(await sdk.documents.query({
  dataContractId: social, documentTypeName, where: [['$ownerId', '==', owner], ['$createdAt', '>', 0]],
  orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 2,
}));
const likesSince = (documentTypeName, author, target) => doc => ({
  dataContractId: social, documentTypeName,
  where: [[author, '==', owner], [target, '==', id(doc.$id)], ['$createdAt', '>', 0]],
  orderBy: [[author, 'asc'], [target, 'asc'], ['$createdAt', 'desc']], limit: 100,
});
await verifyAlone('per-target like notifications', [
  ...(await recentOwn('post')).map(likesSince('like', 'postAuthor', 'postId')),
  ...(await recentOwn('reply')).map(likesSince('likeReply', 'replyAuthor', 'replyId')),
]);
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
