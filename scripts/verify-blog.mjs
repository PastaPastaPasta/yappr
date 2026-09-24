/**
 * Registration-day battery for the **blog contract**
 * (`contracts/yappr-blog-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run live on
 * a beta.1+ devnet. Actors are seed-ledger personas: an AUTHOR, a READER and a
 * STRANGER; comments cost 1 YAPP, so the reader and stranger are topped up first.
 * Every fixture is fresh per run under a new blog, so blog- and post-level
 * aggregates are exact without a baseline; only the YAPP balance is a delta.
 *
 *   NETWORK=devnet node scripts/verify-blog.mjs --contract <id> \
 *     [--author 210] [--reader 211] [--stranger 212] [--moderator 260] [--yapp 20] [--only b4,b5]
 *
 * `--moderator` is the persona the contract was published under (its owner) or
 * one appointed at publish time; v3 (beta.3) is a moderated cut, so b13/b14
 * ban the stranger and take a comment and a post down. v4 (beta.4) keeps a
 * warning list (b17 warns and clears) and stores `labels` as a typed string
 * array (b18: a list reads back as a list; an over-long label is refused).
 *   node scripts/verify-blog.mjs --self-test   # offline: contract declares what the cases assert
 */
import bs58 from 'bs58';
import {
  DELETE_FORBIDDEN, IMMUTABLE_CHANGED, PROPERTY_MISMATCH, REFERENCE_NOT_FOUND, TOKEN_AGREEMENT_MISSING,
  id32, runBattery,
} from './battery-lib.mjs';
import { randomEntropy } from './seed/seed-lib.mjs';
import { ARRAY_OUT_OF_BOUNDS, NOT_A_LIST, REFERENCE_NOT_FOUND_DELETABLE, caseBan, caseModeratorDelete, caseWarn, selfTestModerated } from './battery-moderation.mjs';

const COMMENT_COST = 1n;
const DEFAULT_YAPP = 20n;
/** The daily grid `followersByDay` buckets on (contract timeRange range/step). */
const TODAY = [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 86400 } }];

const blogData = (run, labels) => ({ name: `Battery ${run}`, description: 'blog battery', ...(labels ? { labels } : {}) });
// `publishedAt` is `immutable` + `immutableAllowSetting`: a replace must resend the
// stored value byte-identically, so it is a parameter, not a fresh `Date.now()`.
// Passing `null` omits it, which is how a DRAFT is written.
const postData = ({ blogId, title, slug, publishedAt = Date.now() }) => ({ blogId, title, slug, data0: crypto.getRandomValues(new Uint8Array(64)), ...(publishedAt === null ? {} : { publishedAt }) });
const commentData = ({ blogPostId, blogPostOwnerId, content }) => ({ blogPostId, blogPostOwnerId, content });

// ---- Cases ------------------------------------------------------------------

async function caseB1Fixtures(ctx) {
  const { battery, author, reader, stranger, run } = ctx;
  console.log('\n--- b1. fixtures: blog, two posts, a draft, two follows, three comments ---');
  const blog = await battery.probeCreate('b1a author blog created', null, author, 'blog', blogData(run));
  ctx.blogId = blog.ok ? blog.id : null;
  if (!ctx.blogId) throw new Error('fixture blog unavailable');

  ctx.publishedAt = Date.now(); // Remembered so every later replace resends the frozen value verbatim.
  const base = { blogId: id32(ctx.blogId) };
  const posts = [];
  for (const [label, title, slug, publishedAt] of [
    ['b1b post one created', 'First', 'first', ctx.publishedAt],
    ['b1c post two created', 'Second', 'second', ctx.publishedAt],
    // A draft: `publishedAt` absent, so b12 can publish it exactly once.
    ['b1i draft post created (no publishedAt)', 'Draft', 'draft', null],
  ]) {
    const created = await battery.probeCreate(label, null, author, 'blogPost', postData({ ...base, title: `${title} ${run}`, slug: `${slug}-${run}`, publishedAt }));
    posts.push(created.ok ? created.id : null);
  }
  [ctx.post1, ctx.post2, ctx.draftId] = posts;
  if (!ctx.post1 || !ctx.post2) throw new Error('fixture posts unavailable');

  for (const [label, who] of [['b1d reader follows the blog', reader], ['b1e stranger follows the blog', stranger]]) {
    await battery.probeCreate(label, null, who, 'blogFollow', { blogId: id32(ctx.blogId) });
  }
  const owner = id32(author.ownerId);
  for (const [label, who, postId] of [
    ['b1f reader comments on post one', reader, ctx.post1],
    ['b1g stranger comments on post one', stranger, ctx.post1],
    ['b1h reader comments on post two', reader, ctx.post2],
  ]) {
    const outcome = await battery.probeCreate(label, null, who, 'blogComment', commentData({ blogPostId: id32(postId), blogPostOwnerId: owner, content: `${label} ${run}` }), { tokenCost: COMMENT_COST });
    if (outcome.ok && who === reader) ctx.readerComments += 1;
    if (outcome.ok && who === stranger) ctx.strangerCommentId = outcome.id;
  }
}

async function caseB2BlogRefs(ctx) {
  const { battery, author, reader, run } = ctx;
  console.log('\n--- b2. refersTo on blogId ---');
  await battery.probeCreate('b2a post naming a GHOST blog is rejected (40120)', REFERENCE_NOT_FOUND, author, 'blogPost', postData({ blogId: randomEntropy(), title: `Ghost ${run}`, slug: `ghost-${run}` }));
  await battery.probeCreate('b2b follow naming a GHOST blog is rejected (40120)', REFERENCE_NOT_FOUND, reader, 'blogFollow', { blogId: randomEntropy() });
  // The "a post may attest an author who is not its owner" gap is GONE: there is no
  // `author` property left to lie in, and b3a proves a comment cannot forge one.
}

async function caseB3Comments(ctx) {
  const { battery, author, reader, stranger, run } = ctx;
  console.log('\n--- b3. comments: agreement, ghost post, token payment ---');
  if (!ctx.post1) { battery.check('b3 comments', false, 'no post fixture'); return; }
  const comment = (label, expect, data, options = { tokenCost: COMMENT_COST }) => battery.probeCreate(label, expect, reader, 'blogComment', commentData({ blogPostId: id32(ctx.post1), blogPostOwnerId: id32(author.ownerId), ...data }), options);
  await comment('b3a comment carrying a FORGED blogPostOwnerId is rejected (40127)', PROPERTY_MISMATCH, { blogPostOwnerId: id32(stranger.ownerId), content: `forged ${run}` });
  await comment('b3b comment on a GHOST post is rejected (40120)', REFERENCE_NOT_FOUND, { blogPostId: randomEntropy(), content: `ghost ${run}` });
  await comment('b3c comment WITHOUT a token payment agreement is rejected', TOKEN_AGREEMENT_MISSING, { content: `unpaid ${run}` }, { noPayment: true });
}

async function caseB4Counts(ctx) {
  const { battery } = ctx;
  console.log('\n--- b4. count trees: comments per post, followers per blog ---');
  if (!ctx.post1 || !ctx.post2) { battery.check('b4 counts', false, 'no post fixtures'); return; }
  const [c1, c2] = await Promise.all([
    battery.countBy('blogComment', [['blogPostId', '==', ctx.post1]]),
    battery.countBy('blogComment', [['blogPostId', '==', ctx.post2]]),
  ]);
  battery.check('b4a commentCount per post is exact', c1 === 2 && c2 === 1, `post1=${c1} post2=${c2}`);

  const grouped = await battery.groupedCount('blogComment', [['blogPostId', 'in', [ctx.post1, ctx.post2]]], ['blogPostId'], (hex) => bs58.encode(Uint8Array.from(Buffer.from(hex, 'hex'))));
  battery.check('b4b one grouped count serves a whole post list', grouped.get(ctx.post1) === 2 && grouped.get(ctx.post2) === 1, `keys=${[...grouped.entries()].map(([key, value]) => `${key.slice(0, 8)}=${value}`).join(' ')}`);
  battery.workingShapes.push({ label: 'comment counts for a post list', shape: { documentTypeName: 'blogComment', where: [['blogPostId', 'in', ['<postId>', '…']]], groupBy: ['blogPostId'] } });

  const followers = await battery.countBy('blogFollow', [['blogId', '==', ctx.blogId]]);
  battery.check('b4c followerCount is exact', followers === 2, `followers=${followers}`);

  // The exact shape notification-service uses; the index serves either direction.
  const where = [['blogPostOwnerId', '==', ctx.author.ownerId], ['$createdAt', '>', ctx.startedAt]];
  const [asc, desc] = await Promise.all([
    battery.queryDocs('blogComment', { where, orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'asc']], limit: 100 }),
    battery.queryDocs('blogComment', { where, orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']], limit: 100 }),
  ]);
  battery.check('b4d postOwnerAndTime serves "comments on my posts" since a timestamp, both directions', asc.length === 3 && desc.length === 3, `asc=${asc.length} desc=${desc.length}`);
  battery.workingShapes.push({ label: 'comments on my blog posts since last seen', shape: { documentTypeName: 'blogComment', where: [['blogPostOwnerId', '==', '<me>'], ['$createdAt', '>', '<lastSeen>']], orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']] } });
}

async function caseB5Rankings(ctx) {
  const { battery } = ctx;
  console.log('\n--- b5. rankings: most discussed posts, most followed blogs ---');
  const { page: posts, shape } = await battery.ranked('blogComment', 'blogPostId', { type: 'count' }, { direction: 'desc' });
  const p1 = battery.groupValueOf(posts, ctx.post1);
  const p2 = battery.groupValueOf(posts, ctx.post2);
  battery.check('b5a "most discussed posts" carries both posts at exact counts', Number(p1?.value ?? -1) === 2 && Number(p2?.value ?? -1) === 1, `post1=${p1?.value} post2=${p2?.value} groups=${posts.entries.length}`);
  battery.workingShapes.push({ label: 'most discussed posts', shape });
  const blogs = await battery.checkRanked('b5b "most followed blogs" carries the fixture blog at its exact count', 'blogFollow', 'blogId', ctx.blogId, 2, { direction: 'desc' });
  if (blogs) battery.workingShapes.push({ label: 'most followed blogs', shape: blogs.shape });
}

async function caseB6Windowed(ctx) {
  const { battery } = ctx;
  console.log('\n--- b6. windowed: followers today (daily grid; a cold bucket IS the empty answer) ---');
  const today = await battery.checkRanked('b6a "trending blogs today" carries the fixture blog at its exact count', 'blogFollow', 'blogId', ctx.blogId, 2, { direction: 'desc', timeRange: TODAY });
  if (today) battery.workingShapes.push({ label: 'trending blogs today', shape: today.shape });
}

async function caseB7Edit(ctx) {
  const { battery, author, run } = ctx;
  console.log('\n--- b7. a post edit (replace) with the frozen fields resent verbatim ---');
  if (!ctx.post1) { battery.check('b7 edit', false, 'no post fixture'); return; }
  // blogId and publishedAt come back byte-identical: both are frozen. v3 keeps
  // no revision history (`documentsKeepHistory` was dropped so moderators can
  // delete posts), so the edit is the only thing to assert.
  await battery.probeReplace('b7a post edit (replace) is accepted', null, author, 'blogPost', ctx.post1, postData({ blogId: id32(ctx.blogId), title: `First ${run} (edited)`, slug: `first-${run}`, publishedAt: ctx.publishedAt }), await battery.revisionOf('blogPost', ctx.post1));
  const edited = await battery.fetchDocument('blogPost', ctx.post1);
  battery.check('b7b the stored post carries the edit at a higher revision', Number(edited?.revision ?? 0) >= 2 && edited?.toObject?.().title === `First ${run} (edited)`, `revision=${edited?.revision}`);
}

async function caseB8Permanence(ctx) {
  const { battery, author } = ctx;
  console.log('\n--- b8. permanence: posts and blogs cannot be deleted ---');
  for (const [label, docType, id] of [['b8a blogPost delete is rejected', 'blogPost', ctx.post2], ['b8b blog delete is rejected', 'blog', ctx.blogId]]) {
    await battery.probeDelete(label, DELETE_FORBIDDEN, author, docType, id);
  }
}

async function caseB9Tokens(ctx) {
  const { battery } = ctx;
  console.log('\n--- b9. YAPP accounting ---');
  const after = await battery.yappBalance(ctx.tokenId, ctx.reader.ownerId);
  const spent = ctx.readerYappBefore - after;
  const expected = BigInt(ctx.readerComments) * COMMENT_COST;
  battery.check('b9a reader YAPP dropped by exactly 1 per accepted comment (rejected writes charge nothing)', spent === expected, `before=${ctx.readerYappBefore} after=${after} spent=${spent} expected=${expected}`);
}

async function caseB10CommentDelete(ctx) {
  const { battery, stranger } = ctx;
  console.log('\n--- b10. a deleted comment decrements the count tree ---');
  if (!ctx.strangerCommentId) { battery.check('b10 comment delete', false, 'no comment fixture'); return; }
  await battery.probeDelete('b10a comment delete is accepted', null, stranger, 'blogComment', ctx.strangerCommentId);
  const count = await battery.countBy('blogComment', [['blogPostId', '==', ctx.post1]]);
  battery.check('b10b commentCount reflects the delete', count === 1, `post1=${count}`);
}

async function caseB11FollowDelete(ctx) {
  const { battery, stranger } = ctx;
  console.log("\n--- b11. unfollow: a stored, deletable doc under a TTL'd windowed index ---");
  // blogFollow is the first STORED doctype under a timeRange+ttl index, so its
  // delete path is worth proving explicitly.
  const [follow] = await battery.queryDocs('blogFollow', { where: [['$ownerId', '==', stranger.ownerId], ['blogId', '==', ctx.blogId]], limit: 1 });
  if (!follow) { battery.check('b11 unfollow', false, 'no follow fixture'); return; }
  await battery.probeDelete('b11a unfollow (blogFollow delete) is accepted', null, stranger, 'blogFollow', battery.b58(follow.$id));
  const count = await battery.countBy('blogFollow', [['blogId', '==', ctx.blogId]]);
  battery.check('b11b followerCount reflects the unfollow', count === 1, `followers=${count}`);
  await battery.checkRanked('b11c "most followed blogs" reflects the unfollow', 'blogFollow', 'blogId', ctx.blogId, 1, { direction: 'desc' });
  await battery.checkRanked('b11d the windowed axis reflects the unfollow too', 'blogFollow', 'blogId', ctx.blogId, 1, { direction: 'desc', timeRange: TODAY });
}

async function caseB12Immutable(ctx) {
  const { battery, author, run } = ctx;
  console.log('\n--- b12. immutable blogId, write-once publishedAt ---');
  if (!ctx.post2) { battery.check('b12 immutability', false, 'no post fixture'); return; }
  const edit = (label, expect, id, data, revision) => battery.probeReplace(label, expect, author, 'blogPost', id, data, revision);
  // A REAL second blog to move into, so the rejection is about immutability and not
  // about a reference that does not resolve.
  const otherBlog = await battery.attemptCreate(author, 'blog', blogData(`${run}-alt`));
  if (!otherBlog.ok) { battery.check('b12 immutability', false, 'no second blog fixture'); return; }
  const post2Base = { title: `Second ${run}`, slug: `second-${run}` };
  const revision = await battery.revisionOf('blogPost', ctx.post2);
  for (const [label, data] of [
    ['b12a a replace moving blogId to another REAL blog is rejected (40128)', { blogId: id32(otherBlog.id), publishedAt: ctx.publishedAt }],
    ['b12b a replace re-dating publishedAt is rejected (40128)', { blogId: id32(ctx.blogId), publishedAt: ctx.publishedAt + 86_400_000 }],
    ['b12c a replace DROPPING publishedAt is rejected (40128) — removal counts as a change', { blogId: id32(ctx.blogId), publishedAt: null }],
  ]) await edit(label, IMMUTABLE_CHANGED, ctx.post2, postData({ ...post2Base, ...data }), revision);

  if (!ctx.draftId) { battery.check('b12d draft publish', false, 'no draft fixture'); return; }
  const draftBase = { blogId: id32(ctx.blogId), title: `Draft ${run}`, slug: `draft-${run}` };
  const firstPublish = Date.now();
  await edit('b12d publishing a DRAFT sets publishedAt for the first time (immutableAllowSetting)', null, ctx.draftId, postData({ ...draftBase, publishedAt: firstPublish }), await battery.revisionOf('blogPost', ctx.draftId));
  await edit('b12e re-dating the now-published draft is rejected (40128) — allow-setting is once only', IMMUTABLE_CHANGED, ctx.draftId, postData({ ...draftBase, publishedAt: firstPublish + 1000 }), await battery.revisionOf('blogPost', ctx.draftId));
}

async function caseB13Ban(ctx) {
  const { battery, stranger, author, run } = ctx;
  const comment = () => battery.attemptCreate(stranger, 'blogComment', commentData({ blogPostId: id32(ctx.post1), blogPostOwnerId: id32(author.ownerId), content: `banned ${run} ${Date.now()}` }), { tokenCost: COMMENT_COST });
  await caseBan(ctx, { prefix: 'b13', target: stranger, writeWhileBanned: comment, writeAfterUnban: comment });
}

async function caseB14ModeratorDelete(ctx) {
  const { battery, author, reader, run } = ctx;
  // A fresh comment by the reader, then the post it hangs off: the takedown of
  // the post must leave the comment's `blogPostId` dangling (deletableDocument).
  const post = await battery.attemptCreate(author, 'blogPost', postData({ blogId: id32(ctx.blogId), title: `Doomed ${run}`, slug: `doomed-${run}`, publishedAt: ctx.publishedAt }));
  if (!post.ok) { battery.check('b14 fixture', false, 'no post to take down'); return; }
  const comment = await battery.attemptCreate(reader, 'blogComment', commentData({ blogPostId: id32(post.id), blogPostOwnerId: id32(author.ownerId), content: `on the doomed post ${run}` }), { tokenCost: COMMENT_COST });
  if (comment.ok) ctx.readerComments += 1;
  await caseModeratorDelete(ctx, { prefix: 'b14', docType: 'blogComment', documentId: comment.ok ? comment.id : null, ownerId: reader.ownerId });
  await caseModeratorDelete(ctx, {
    prefix: 'b15', docType: 'blogPost', documentId: post.id, ownerId: author.ownerId,
    afterwards: async () => {
      // A comment on the removed post: the reference no longer resolves.
      await battery.probeCreate('b15d a comment on the removed post is refused (40120)', REFERENCE_NOT_FOUND_DELETABLE, reader, 'blogComment', commentData({ blogPostId: id32(post.id), blogPostOwnerId: id32(author.ownerId), content: `too late ${run}` }), { tokenCost: COMMENT_COST });
      // blog is moderator-deletable too, but the fixture blog carries every
      // other case's documents, so a THROWAWAY blog is what goes.
      const doomedBlog = await battery.attemptCreate(author, 'blog', blogData(`${run}-doomed`));
      if (doomedBlog.ok) await caseModeratorDelete(ctx, { prefix: 'b16', docType: 'blog', documentId: doomedBlog.id, ownerId: author.ownerId });
    },
  });
}

async function caseB17Warn(ctx) {
  const { battery, stranger, author, run } = ctx;
  const comment = () => battery.attemptCreate(stranger, 'blogComment', commentData({ blogPostId: id32(ctx.post1), blogPostOwnerId: id32(author.ownerId), content: `warned ${run} ${Date.now()}` }), { tokenCost: COMMENT_COST });
  await caseWarn(ctx, { prefix: 'b17', target: stranger, writeWhileWarned: comment });
}

async function caseB18TypedLabels(ctx) {
  const { battery, author, run } = ctx;
  console.log('\n--- b18. labels are a typed string array (beta.4 v4) ---');
  const labels = ['postmortems', 'oncall', 'databases'];
  const blog = await battery.probeCreate('b18a a blog with labels as a LIST lands', null, author, 'blog', blogData(`${run}-labels`, labels));
  if (!blog.ok) return;
  const stored = await battery.fetchDocument('blog', blog.id);
  const back = stored?.toJSON?.().labels;
  battery.check('b18b the labels read back as the same list, in order', JSON.stringify(back) === JSON.stringify(labels), JSON.stringify(back));
  const post = await battery.probeCreate('b18c a post labelled with a subset of the taxonomy lands', null, author, 'blogPost', { ...postData({ blogId: id32(blog.id), title: `Labelled ${run}`, slug: `labelled-${run}`, publishedAt: Date.now() }), labels: ['oncall'] });
  if (post.ok) battery.check('b18d …and reads back as a list', JSON.stringify((await battery.fetchDocument('blogPost', post.id))?.toJSON?.().labels) === '["oncall"]');
  await battery.probeCreate('b18e a label over 40 characters is refused', ARRAY_OUT_OF_BOUNDS, author, 'blog', blogData(`${run}-long`, ['x'.repeat(41)]));
  await battery.probeCreate('b18f a duplicate label is refused (uniqueItems)', ARRAY_OUT_OF_BOUNDS, author, 'blog', blogData(`${run}-dup`, ['oncall', 'oncall']));
  await battery.probeCreate('b18g the v3 comma-separated STRING is refused on v4', NOT_A_LIST, author, 'blog', blogData(`${run}-csv`, 'oncall,databases'));
}

const CASES = new Map([
  ['b1', caseB1Fixtures], ['b2', caseB2BlogRefs], ['b3', caseB3Comments], ['b4', caseB4Counts],
  ['b5', caseB5Rankings], ['b6', caseB6Windowed], ['b7', caseB7Edit], ['b8', caseB8Permanence],
  ['b9', caseB9Tokens], ['b10', caseB10CommentDelete], ['b11', caseB11FollowDelete], ['b12', caseB12Immutable],
  ['b13', caseB13Ban], ['b14', caseB14ModeratorDelete], ['b17', caseB17Warn], ['b18', caseB18TypedLabels],
]);

await runBattery({
  label: 'blog',
  contract: { env: 'BLOG_CONTRACT_ID' },
  cases: CASES,
  actors: { author: 210, reader: 211, stranger: 212, moderator: 260 },
  yapp: { default: DEFAULT_YAPP, actors: ['reader', 'stranger'], require: true },
  banner: ({ socialId }) => `; YAPP from ${socialId}`,
  selfTest: () => selfTestModerated('yappr-blog-contract.json', {
    // b3a: the notification key binds to the post's REAL owner.
    blogComment: { agreements: { blogPostId: { blogPostOwnerId: '$ownerId' } }, moderatorDeletable: true },
    // b12: blogId frozen, publishedAt write-once. b15: moderators may remove a post.
    // b18: labels are typed string arrays (beta.4 v4).
    blogPost: { immutable: ['blogId', 'publishedAt'], immutableAllowSetting: ['publishedAt'], moderatorDeletable: true, keepsHistory: false, typedArrays: { labels: { items: 'string', maxItems: 16, maxLength: 40 } } },
    blog: { moderatorDeletable: true, keepsHistory: false, typedArrays: { labels: { items: 'string', maxItems: 64, maxLength: 40 } } },
  }, { moderation: { banlist: true, suspensions: true, warnings: true } }),
  setup: async ({ battery, tokenId, reader, moderator }) => ({ startedAt: Date.now() - 60_000, readerComments: 0, strangerCommentId: null, draftId: null, publishedAt: null, readerYappBefore: await battery.yappBalance(tokenId, reader.ownerId), moderator: { ...moderator, identity: await battery.readback(() => battery.sdk.identities.fetch(moderator.ownerId)) } }),
  summary: (ctx) => `blog=${ctx.blogId} posts=${ctx.post1},${ctx.post2}`,
});
