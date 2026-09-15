#!/usr/bin/env node
/** Read-only equivalence probes against the deployed devnet. No signing keys.
 * NETWORK=devnet node scripts/verify-social-query-bundles.mjs [report.json]
 * Counts document facade requests after connection/contract warm-up, not HTTP
 * retries, subqueries, quorum reads, or complete rendered-screen traffic. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import bs58 from 'bs58';
import { connectSdk } from './sdk-env.mjs';

const social = 'CdUkSHkQwGXXAkzKqrcrjUWLsj7qErK9XAZmLzJEhirU';
const profile = '6cyzfCVkov5RqJzRpXTmCAjYWBGqB1SzsBxrsnd8AUyb';
const dpns = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const dm = 'ACggUAB9rYpZUTBggrgx54R43iSprQztyuwYx16Y25xC';
const blog = '3XiMRzaPPjknf2fYtz6oGob4G5D69A9MLu4x58A8WZiF';
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
  where: [['language', '==', 'en'], ['$createdAt', '>', 0]],
  orderBy: [['language', 'asc'], ['$createdAt', 'desc']], limit: 20,
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
await verify('notification sources', [
  ['follow', 'followingId'], ['postMention', 'mentionedUserId'], ['followRequest', 'targetId'],
  ['like', 'postAuthor'], ['likeReply', 'replyAuthor'], ['repost', 'postOwnerId'], ['reply', 'parentOwnerId'],
].map(([documentTypeName, field]) => ({
  dataContractId: social, documentTypeName,
  where: [[field, '==', owner], ['$createdAt', '>', 0]],
  orderBy: [[field, 'asc'], ['$createdAt', 'asc']], limit: 100,
})));
await verify('following repost pages', owners.map(ownerId => ({
  dataContractId: social, documentTypeName: 'repost',
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

async function verifyEnrichment(kind) {
  const name = `${kind} composite enrichment counts and viewer marks`;
  try {
    const pageQuery = { dataContractId: social, documentTypeName: kind,
      where: [['$ownerId', '==', owner], ['$createdAt', '>', 0]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 20 };
    const page = records(await sdk.documents.query(pageQuery));
    const ids = page.map(doc => id(doc.$id));
    const targetField = kind === 'post' ? 'postId' : 'replyId';
    const likeType = kind === 'post' ? 'like' : 'likeReply';
    const countSources = [[likeType, targetField],
      ...(kind === 'post' ? [['repost', 'postId']] : []),
      ['reply', kind === 'post' ? 'rootPostId' : 'replyToReplyId'],
      ['post', kind === 'post' ? 'quotedPostId' : 'quotedReplyId']];
    const subQueries = countSources.map(([documentType, field]) => ({
      documentType, kind: 'counts', bind: { source: 'page', sourceProperty: '$id', field },
    }));
    subQueries.push({ documentType: likeType, where: [['$ownerId', '==', owner]],
      bind: { source: 'page', sourceProperty: '$id', field: targetField } });
    const result = await sdk.documents.composite({
      dataContractId: social, documentType: kind, where: pageQuery.where,
      orderBy: pageQuery.orderBy, limit: 20, subQueries,
    });
    assert.equal(canonical(result.pageDocuments.map(doc => doc.toObject())), canonical(page));
    for (let i = 0; i < countSources.length; i++) {
      const [documentTypeName, field] = countSources[i];
      const counts = ids.length ? await sdk.documents.count({ dataContractId: social,
        documentTypeName, where: [[field, 'in', ids]], groupBy: [field] }) : new Map();
      for (const postId of ids) {
        const hex = Buffer.from(bs58.decode(postId)).toString('hex');
        assert.equal(Number(result.subResults[i].counts.get(postId) ?? 0), Number(counts.get(hex) ?? 0));
      }
    }
    const marks = ids.length ? records(await sdk.documents.query({ dataContractId: social,
      documentTypeName: likeType, where: [['$ownerId', '==', owner], [targetField, 'in', ids]],
      orderBy: [[targetField, 'desc']], limit: ids.length })) : [];
    assert.equal(canonical(result.subResults.at(-1).documents.map(doc => doc.toObject())), canonical(marks));
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

const report = { at: new Date().toISOString(), network: 'moutai', baseline: '4105c5d1', reports };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
process.exit(reports.every(result => result.equivalent) ? 0 : 1);
