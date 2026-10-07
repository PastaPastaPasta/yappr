/**
 * Registration-day battery for the **blog contract**
 * (`contracts/yappr-blog-contract.json`, docs/NON_SOCIAL_CONTRACTS.md), run live on
 * a 5.0.0-beta.2+ devnet. Actors are seed-ledger personas: an AUTHOR, a READER and a
 * STRANGER. Every fixture is fresh per run under a new blog, so blog- and
 * post-level aggregates are exact without a baseline.
 *
 *   NETWORK=devnet node scripts/verify-blog.mjs --contract <id> \
 *     [--author 210] [--reader 211] [--stranger 212] [--moderator 260|maker|personal] [--only b4,b5]
 *
 * `--moderator` is the contract's owner or one it appointed at publish time:
 * a seed-ledger persona index, `maker` or `personal` (ledger persona 900); v3 (beta.3) is a moderated cut, so b13/b14
 * ban the stranger and take a comment and a post down. v4 (beta.4) keeps a
 * warning list (b17 warns and clears) and stores `labels` as a typed string
 * array (b18: a list reads back as a list; an over-long label is refused). The
 * beta.5 re-cut adds `propertyConstraints` (b19: content chunks are contiguous;
 * a gap is refused 10422). The beta.6 re-cut (v5) makes a comment copy its
 * post's `commentsEnabled` (b20: a comment on a comments-off post is refused)
 * and lets only a blog's owner post to it (b21). The 5.0.0-beta.1 re-cut (v6)
 * drops the copied `blogPostOwnerId`: `postOwnerAndTime` derives the post's
 * owner through `blogPostId` (b4d), so there is no owner left to forge: a
 * comment still carrying it is refused (b3d), nobody else's query sees the
 * comments (b4e), and the derived key is read from a removed post's record
 * when a comment outlives its post (b15e-g).
 *
 * Blog v7 (5.0.0-beta.2, this file) changes what the cases write and read:
 *   - no YAPP: `blog`, `blogPost` and `blogComment` creates carry an action fee
 *     agreement (the declared amounts, read off the contract JSON); b3c is a
 *     create without one (40132), b9 one agreeing to the wrong amount (40133);
 *   - the count twins are merged: comment counts read `postAndTime`, follower
 *     counts and "most followed" `followers` (b4, b5b, b11: the same queries);
 *     "most discussed" is the 72h `discussedRecent` window (b5a), "trending"
 *     the 72h `followersTrend` window (b6, b11d);
 *   - `blogPost.ownerAndTime`, `blogComment.ownerAndTime`, `blogFollow.following`
 *     and the all-time comment ranking are gone (the self-test pins it);
 *   - an author deletes a post with a TOMBSTONE (b22): `deleted`, comments off,
 *     every content field absent, blogId/slug/publishedAt kept; `deleted` is
 *     frozen once set; a banned author may still write it and nothing else
 *     (`retractedWhen`, b23); a tombstone takes no comment (b24);
 *   - `publishedAt` may not run 10 minutes past `$updatedAt` (b19, from the
 *     shared constraint cases).
 * The moderation is ELECTED (interim: the contract owner, which the
 * `--moderator` flag must name for b13-b17 and b23).
 *   node scripts/verify-blog.mjs --self-test   # offline: contract declares what the cases assert
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { DocumentActionFeeAgreement } from '@dashevo/evo-sdk';
import {
  DELETE_FORBIDDEN, DUPLICATE_UNIQUE, IMMUTABLE_CHANGED, PROPERTY_MISMATCH, REFERENCE_NOT_FOUND,
  MODERATOR_FLAG, id32, reportSelfTest, runBattery,
} from './battery-lib.mjs';
import { REPO_ROOT, actionFeeAgreementOptions, actionFeeFor, feeAgreementFor, feeMultiplierPermille, randomEntropy } from './seed/seed-lib.mjs';
import { ARRAY_OUT_OF_BOUNDS, BANNED, NOT_A_LIST, REFERENCE_NOT_FOUND_DELETABLE, caseBan, caseModeratorDelete, caseWarn, selfTestModerated } from './battery-moderation.mjs';
import { AGREEMENT_MISMATCH, AGREEMENT_NOT_SET, liftBar } from './social-battery-lib.mjs';
import { DECLARED_RULES, constraintViolation, drop, refusedCreates, refusedReplaces } from './property-constraint-cases.mjs';

const CONTRACT_FILE = 'yappr-blog-contract.json';
const CONTRACT = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', CONTRACT_FILE), 'utf8'));
const SCHEMAS = CONTRACT.documentSchemas;
/** A property the type does not declare (`additionalProperties: false`): JSON-schema 10101. */
const UNKNOWN_PROPERTY = /\bcode"?\s*[=:]\s*10101\b|jsonschemaerror|additional ?propert/i;

/** An index `docType` declares, by name (undefined when it declares none). */
const index = (docType, name) => (SCHEMAS[docType].indices ?? []).find((entry) => entry.name === name);

/** A v7 trend window as `documents.ranked()` names it: the index's own grid, the window covering it all. */
function trendWindow(docType, name) {
  const { range, step } = index(docType, name).timeRange;
  return [{ field: '$createdAt', selector: 'oldest', grid: { range, step } }];
}

/** The blog every later case writes under: b1's, or (for `--only`) a fresh one. Null when none could be made. */
async function ensureFixtureBlog(ctx, prefix) {
  if (!ctx.blogId) {
    const blog = await ctx.battery.probeCreate(`${prefix} fixture blog created`, null, ctx.author, 'blog', blogData(`${ctx.run}-${prefix}`));
    ctx.blogId = blog.ok ? blog.id : null;
  }
  return ctx.blogId;
}
/** "Trending blogs" (72h, a new window every 24h). */
const TRENDING = trendWindow('blogFollow', 'followersTrend');
/** "Most discussed posts" over the same window. */
const DISCUSSED = trendWindow('blogComment', 'discussedRecent');

const blogData = (run, labels) => ({ name: `Battery ${run}`, description: 'blog battery', ...(labels ? { labels } : {}) });
// `publishedAt` is frozen once stored (5.0.0-beta.1: the conditional `immutable`
// entry `{ present: "$old.publishedAt" }`; beta.7 said it with
// `immutableAllowSetting`): a replace must resend the stored value
// byte-identically, so it is a parameter, not a fresh `Date.now()`.
// Passing `null` omits it, which is how a DRAFT is written.
const postData = ({ blogId, title, slug, publishedAt = Date.now() }) => ({ blogId, title, slug, data0: crypto.getRandomValues(new Uint8Array(64)), ...(publishedAt === null ? {} : { publishedAt }) });
// v5 (beta.6): `postCommentsEnabled` must equal the post's `commentsEnabled`,
// absence included (40127). Every fixture post leaves the flag out, so the
// fixture comments leave it out too; b20 writes the other shapes.
// v6 (5.0.0-beta.1): no `blogPostOwnerId`; `postOwnerAndTime` derives the post's
// owner through `blogPostId` (`blogPostId.$ownerId`).
const commentData = ({ blogPostId, content, postCommentsEnabled }) => ({ blogPostId, content, ...(postCommentsEnabled === undefined ? {} : { postCommentsEnabled }) });

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
  for (const [label, who, postId] of [
    ['b1f reader comments on post one', reader, ctx.post1],
    ['b1g stranger comments on post one', stranger, ctx.post1],
    ['b1h reader comments on post two', reader, ctx.post2],
  ]) {
    const outcome = await battery.probeCreate(label, null, who, 'blogComment', commentData({ blogPostId: id32(postId), content: `${label} ${run}` }));
    if (outcome.ok && who === stranger) ctx.strangerCommentId = outcome.id;
  }
}

async function caseB2BlogRefs(ctx) {
  const { battery, author, reader, run } = ctx;
  console.log('\n--- b2. refersTo on blogId ---');
  await battery.probeCreate('b2a post naming a GHOST blog is rejected (40120)', REFERENCE_NOT_FOUND, author, 'blogPost', postData({ blogId: randomEntropy(), title: `Ghost ${run}`, slug: `ghost-${run}` }));
  await battery.probeCreate('b2b follow naming a GHOST blog is rejected (40120)', REFERENCE_NOT_FOUND, reader, 'blogFollow', { blogId: randomEntropy() });
  // The "a post may attest an author who is not its owner" gap is GONE: there is no
  // `author` property left to lie in, and from v6 a comment carries no post owner
  // either: `postOwnerAndTime` reads it from the post (b4d).
}

async function caseB3Comments(ctx) {
  const { battery, reader, run } = ctx;
  console.log('\n--- b3. comments: ghost post, the action fee agreement ---');
  if (!ctx.post1) { battery.check('b3 comments', false, 'no post fixture'); return; }
  const comment = (label, expect, data, options) => battery.probeCreate(label, expect, reader, 'blogComment', commentData({ blogPostId: id32(ctx.post1), ...data }), options);
  await comment('b3b comment on a GHOST post is rejected (40120)', REFERENCE_NOT_FOUND, { blogPostId: randomEntropy(), content: `ghost ${run}` });
  await comment('b3c comment WITHOUT an action fee agreement is refused (40132)', AGREEMENT_NOT_SET, { content: `unpaid ${run}` }, { noAgreement: true });
  // v6 has no `blogPostOwnerId`: a client still on v5 (copying the owner) is refused (10101,
  // additionalProperties), not silently accepted. The field is spread past commentData(),
  // which would drop it before it reached the document. A refused write charges no fee.
  await battery.probeCreate('b3d a v6 comment that still copies blogPostOwnerId is refused (10101)', UNKNOWN_PROPERTY, reader, 'blogComment',
    { ...commentData({ blogPostId: id32(ctx.post1), content: `stale client ${run}` }), blogPostOwnerId: id32(ctx.author.ownerId) });
}

async function caseB4Counts(ctx) {
  const { battery } = ctx;
  console.log('\n--- b4. count trees: comments per post (postAndTime), followers per blog (followers) ---');
  if (!ctx.post1 || !ctx.post2) { battery.check('b4 counts', false, 'no post fixtures'); return; }
  const [c1, c2] = await Promise.all([
    battery.countBy('blogComment', [['blogPostId', '==', ctx.post1]]),
    battery.countBy('blogComment', [['blogPostId', '==', ctx.post2]]),
  ]);
  battery.check('b4a comments per post (the merged postAndTime, prefix total) are exact', c1 === 2 && c2 === 1, `post1=${c1} post2=${c2}`);

  const grouped = await battery.groupedCount('blogComment', [['blogPostId', 'in', [ctx.post1, ctx.post2]]], ['blogPostId'], (hex) => bs58.encode(Uint8Array.from(Buffer.from(hex, 'hex'))));
  battery.check('b4b one grouped count serves a whole post list', grouped.get(ctx.post1) === 2 && grouped.get(ctx.post2) === 1, `keys=${[...grouped.entries()].map(([key, value]) => `${key.slice(0, 8)}=${value}`).join(' ')}`);
  battery.workingShapes.push({ label: 'comment counts for a post list', shape: { documentTypeName: 'blogComment', where: [['blogPostId', 'in', ['<postId>', '…']]], groupBy: ['blogPostId'] } });

  const followers = await battery.countBy('blogFollow', [['blogId', '==', ctx.blogId]]);
  battery.check('b4c followers per blog (the merged followers, prefix total) are exact', followers === 2, `followers=${followers}`);

  // The exact shape notification-service uses; the index serves either direction.
  // v6: the post owner is the derived `blogPostId.$ownerId`, pinned with `==`.
  const where = [['blogPostId.$ownerId', '==', ctx.author.ownerId], ['$createdAt', '>', ctx.startedAt]];
  const [asc, desc] = await Promise.all([
    battery.queryDocs('blogComment', { where, orderBy: [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100 }),
    battery.queryDocs('blogComment', { where, orderBy: [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 100 }),
  ]);
  battery.check('b4d postOwnerAndTime serves "comments on my posts" since a timestamp, both directions', asc.length === 3 && desc.length === 3, `asc=${asc.length} desc=${desc.length}`);
  // The derived key is the referenced post's own `$ownerId`: nobody else's notification query sees these comments.
  const foreign = await battery.queryDocs('blogComment', { where: [['blogPostId.$ownerId', '==', ctx.stranger.ownerId], ['$createdAt', '>', ctx.startedAt]], orderBy: [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100 });
  battery.check('b4e postOwnerAndTime credits no comment to someone who does not own the post', foreign.length === 0, `stranger rows=${foreign.length}`);
  battery.workingShapes.push({ label: 'comments on my blog posts since last seen', shape: { documentTypeName: 'blogComment', where: [['blogPostId.$ownerId', '==', '<me>'], ['$createdAt', '>', '<lastSeen>']], orderBy: [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'desc']] } });
}

async function caseB5Rankings(ctx) {
  const { battery } = ctx;
  console.log('\n--- b5. rankings: most discussed posts (3 days), most followed blogs ---');
  // v7 keeps no all-time comment ranking: "most discussed" is the discussedRecent window.
  const discussed = await battery.checkRanked('b5a "most discussed (3 days)" carries post one at its exact count', 'blogComment', 'blogPostId', ctx.post1, 2, { direction: 'desc', timeRange: DISCUSSED });
  if (discussed) {
    const p2 = battery.groupValueOf(discussed.page, ctx.post2);
    battery.check('b5a2 …and post two at its own', Number(p2?.value ?? -1) === 1, `post2=${p2?.value}`);
    battery.workingShapes.push({ label: 'most discussed posts (3 days)', shape: discussed.shape });
  }
  const blogs = await battery.checkRanked('b5b "most followed blogs" carries the fixture blog at its exact count', 'blogFollow', 'blogId', ctx.blogId, 2, { direction: 'desc' });
  if (blogs) battery.workingShapes.push({ label: 'most followed blogs', shape: blogs.shape });
}

async function caseB6Windowed(ctx) {
  const { battery } = ctx;
  console.log('\n--- b6. windowed: trending blogs (followersTrend, 72h stepping 24h; a cold window IS the empty answer) ---');
  const trending = await battery.checkRanked('b6a "trending (3 days)" carries the fixture blog at its exact count', 'blogFollow', 'blogId', ctx.blogId, 2, { direction: 'desc', timeRange: TRENDING });
  if (trending) battery.workingShapes.push({ label: 'trending blogs (3 days)', shape: trending.shape });
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
  console.log('\n--- b8. permanence: posts and blogs cannot be deleted (an author tombstones a post, b22) ---');
  for (const [label, docType, id] of [['b8a blogPost delete is rejected', 'blogPost', ctx.post2], ['b8b blog delete is rejected', 'blog', ctx.blogId]]) {
    await battery.probeDelete(label, DELETE_FORBIDDEN, author, docType, id);
  }
}

async function caseB9FeeMismatch(ctx) {
  const { battery, reader, run } = ctx;
  console.log('\n--- b9. the action fee agreement must name the declared amount ---');
  if (!ctx.post1) { battery.check('b9 fee mismatch', false, 'no post fixture'); return; }
  // ABOVE the declared moderators fee: a LOWER one on an elected contract is a discount claim (40139).
  const declared = actionFeeFor('blogComment', SCHEMAS);
  const agreement = new DocumentActionFeeAgreement(actionFeeAgreementOptions({ ...declared, moderators: declared.moderators + 1n }, await feeMultiplierPermille(battery.sdk)));
  await battery.probeCreate('b9a a comment agreeing to a different moderators fee is refused (40133)', AGREEMENT_MISMATCH, reader, 'blogComment',
    commentData({ blogPostId: id32(ctx.post1), content: `overpaid ${run}` }), { agreement });
}

async function caseB10CommentDelete(ctx) {
  const { battery, stranger } = ctx;
  console.log('\n--- b10. a deleted comment decrements the count tree ---');
  if (!ctx.strangerCommentId) { battery.check('b10 comment delete', false, 'no comment fixture'); return; }
  await battery.probeDelete('b10a comment delete is accepted', null, stranger, 'blogComment', ctx.strangerCommentId);
  const count = await battery.countBy('blogComment', [['blogPostId', '==', ctx.post1]]);
  battery.check('b10b the comment count reflects the delete', count === 1, `post1=${count}`);
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
  battery.check('b11b the follower count reflects the unfollow', count === 1, `followers=${count}`);
  await battery.checkRanked('b11c "most followed blogs" reflects the unfollow', 'blogFollow', 'blogId', ctx.blogId, 1, { direction: 'desc' });
  await battery.checkRanked('b11d the trend window reflects the unfollow too', 'blogFollow', 'blogId', ctx.blogId, 1, { direction: 'desc', timeRange: TRENDING });
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
  await edit('b12d publishing a DRAFT sets publishedAt for the first time (frozen only once stored)', null, ctx.draftId, postData({ ...draftBase, publishedAt: firstPublish }), await battery.revisionOf('blogPost', ctx.draftId));
  await edit('b12e re-dating the now-published draft is rejected (40128) — publishedAt is set once only', IMMUTABLE_CHANGED, ctx.draftId, postData({ ...draftBase, publishedAt: firstPublish + 1000 }), await battery.revisionOf('blogPost', ctx.draftId));
}

async function caseB13Ban(ctx) {
  const { battery, stranger, run } = ctx;
  const comment = () => battery.attemptCreate(stranger, 'blogComment', commentData({ blogPostId: id32(ctx.post1), content: `banned ${run} ${Date.now()}` }));
  await caseBan(ctx, { prefix: 'b13', target: stranger, writeWhileBanned: comment, writeAfterUnban: comment });
}

async function caseB14ModeratorDelete(ctx) {
  const { battery, author, reader, run } = ctx;
  // A fresh comment by the reader, then the post it hangs off: the takedown of
  // the post leaves the comment's `blogPostId` resolving to the removal record
  // (a `moderatedDocument` reference from 5.0.0-beta.1).
  const post = await battery.attemptCreate(author, 'blogPost', postData({ blogId: id32(ctx.blogId), title: `Doomed ${run}`, slug: `doomed-${run}`, publishedAt: ctx.publishedAt }));
  if (!post.ok) { battery.check('b14 fixture', false, 'no post to take down'); return; }
  const comment = await battery.attemptCreate(reader, 'blogComment', commentData({ blogPostId: id32(post.id), content: `on the doomed post ${run}` }));
  // A second comment outlives the post's takedown, so b15e-g can show the derived
  // `blogPostId.$ownerId` being read from the post's removal record (v6).
  const survivor = await battery.attemptCreate(reader, 'blogComment', commentData({ blogPostId: id32(post.id), content: `outlives the doomed post ${run}` }));
  const listedForAuthor = async () => (await battery.queryDocs('blogComment', { where: [['blogPostId.$ownerId', '==', author.ownerId], ['$createdAt', '>', ctx.startedAt]], orderBy: [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100 }))
    .some((d) => battery.b58(d.$id ?? d.id) === survivor.id);
  await caseModeratorDelete(ctx, { prefix: 'b14', docType: 'blogComment', documentId: comment.ok ? comment.id : null, ownerId: reader.ownerId });
  await caseModeratorDelete(ctx, {
    prefix: 'b15', docType: 'blogPost', documentId: post.id, ownerId: author.ownerId,
    afterwards: async () => {
      // A comment on the removed post: a write must name a document in state,
      // even through a moderatedDocument reference.
      await battery.probeCreate('b15d a comment on the removed post is refused (40120)', REFERENCE_NOT_FOUND_DELETABLE, reader, 'blogComment', commentData({ blogPostId: id32(post.id), content: `too late ${run}` }));
      if (survivor.ok) {
        battery.check('b15e postOwnerAndTime still lists a comment whose post was taken down', await listedForAuthor());
        // The delete clears the derived index entry, so Drive must read the
        // post's `$ownerId` from the removal record (the post is gone from state).
        await battery.probeDelete('b15f the commenter deletes that comment after the takedown', null, reader, 'blogComment', survivor.id);
        battery.check('b15g …and postOwnerAndTime no longer lists it', !(await listedForAuthor()));
      } else battery.check('b15e-g fixture', false, 'no surviving comment');
      // blog is moderator-deletable too, but the fixture blog carries every
      // other case's documents, so a THROWAWAY blog is what goes.
      const doomedBlog = await battery.attemptCreate(author, 'blog', blogData(`${run}-doomed`));
      if (doomedBlog.ok) await caseModeratorDelete(ctx, { prefix: 'b16', docType: 'blog', documentId: doomedBlog.id, ownerId: author.ownerId });
    },
  });
}

async function caseB17Warn(ctx) {
  const { battery, stranger, run } = ctx;
  const comment = () => battery.attemptCreate(stranger, 'blogComment', commentData({ blogPostId: id32(ctx.post1), content: `warned ${run} ${Date.now()}` }));
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

async function caseB19PropertyConstraints(ctx) {
  const { battery, author, run } = ctx;
  console.log('\n--- b19. propertyConstraints on a create (10422): chunks contiguous, a body, publishedAt not ahead ---');
  // Under b1's fixture blog, or (for `--only b19`) a fresh one; b1b/b1c (one chunk each) are the accepted side.
  if (!(await ensureFixtureBlog(ctx, 'b19'))) return;
  for (const [label, data, rule] of refusedCreates(CONTRACT_FILE, 'blogPost')) {
    await battery.probeCreate(`b19 ${label} is refused (10422 ${rule})`, constraintViolation(rule), author, 'blogPost', { ...data, blogId: id32(ctx.blogId), slug: `gap-${run}-${Date.now()}` });
  }
}

async function caseB20CommentsOff(ctx) {
  const { battery, author, reader, run } = ctx;
  console.log('\n--- b20. a comment carries its post\'s commentsEnabled; comments off is refused (beta.6 v5) ---');
  if (!(await ensureFixtureBlog(ctx, 'b20'))) return;
  const post = (title, commentsEnabled) => battery.probeCreate(`b20 fixture post with commentsEnabled ${commentsEnabled}`, null, author, 'blogPost',
    { ...postData({ blogId: id32(ctx.blogId), title: `${title} ${run}`, slug: `${title.toLowerCase()}-${run}` }), commentsEnabled });
  const [on, off] = [await post('Open', true), await post('Closed', false)];
  const comment = (label, expect, postId, postCommentsEnabled) => battery.probeCreate(label, expect, reader, 'blogComment',
    commentData({ blogPostId: id32(postId), content: `${label} ${run}`, postCommentsEnabled }));
  if (on.ok) {
    await comment('b20a a comment copying commentsEnabled true lands', null, on.id, true);
    await comment('b20b a comment leaving the flag out of a post that stores true is refused (40127)', PROPERTY_MISMATCH, on.id, undefined);
  }
  if (off.ok) {
    // The document's own rules (10422) run before the reference checks (40127).
    // The honest copy of `false` breaks \`commentsOpen\`; lying about it (true, or
    // leaving it out, which the rule reads as on) passes the rule and then
    // breaks the agreement.
    await comment('b20c a comment on a comments-off post is refused (10422 commentsOpen)', constraintViolation('commentsOpen'), off.id, false);
    await comment('b20d claiming comments are on for a comments-off post is refused (40127)', PROPERTY_MISMATCH, off.id, true);
    await comment('b20e leaving the flag out on a comments-off post is refused (40127)', PROPERTY_MISMATCH, off.id, undefined);
  }
}

async function caseB21OwnerGate(ctx) {
  const { battery, author, stranger, run } = ctx;
  console.log('\n--- b21. only a blog\'s owner posts to it (beta.6 v5) ---');
  if (!(await ensureFixtureBlog(ctx, 'b21'))) return;
  // Before v5 a stranger could squat a slug on someone else's blog (blogAndSlug is unique).
  await battery.probeCreate('b21a a stranger posting to the author\'s blog is refused (40127)', PROPERTY_MISMATCH, stranger, 'blogPost',
    postData({ blogId: id32(ctx.blogId), title: `Squat ${run}`, slug: `squat-${run}` }));
}

/** A fixture post for the tombstone cases (`publishedAt` kept so the tombstone resends it), and `replace` for it. */
async function tombstoneFixture(ctx, prefix) {
  const { battery, author, run } = ctx;
  if (!(await ensureFixtureBlog(ctx, prefix))) return null;
  const publishedAt = Date.now();
  const slug = `${prefix}-${run}-${Date.now().toString(36)}`;
  const post = await battery.attemptCreate(author, 'blogPost', postData({ blogId: id32(ctx.blogId), title: `Doomed ${prefix} ${run}`, slug, publishedAt }));
  if (!post.ok) { battery.check(`${prefix} fixture post`, false, (post.error ?? '').slice(0, 200)); return null; }
  // The author's replace of this post, at its current revision.
  const replace = async (label, expect, data) => battery.probeReplace(label, expect, author, 'blogPost', post.id, data, await battery.revisionOf('blogPost', post.id));
  return { id: post.id, slug, publishedAt, replace };
}

/** What an author's delete writes (`tombstoneIsBlank`): the flag, comments off, and the kept fields. */
const tombstoneData = (ctx, fixture, extra = {}) => ({ blogId: id32(ctx.blogId), slug: fixture.slug, publishedAt: fixture.publishedAt, deleted: true, commentsEnabled: false, ...extra });

async function caseB22Tombstone(ctx) {
  const { battery, author, run } = ctx;
  console.log('\n--- b22. an author deletes a post with a tombstone (v7 tombstoneIsBlank, deleted frozen) ---');
  const fixture = await tombstoneFixture(ctx, 'b22');
  if (!fixture) return;
  const { replace } = fixture;
  // The refused shapes come from the shared table, so the offline oracle judged them first.
  for (const [label, data, rule] of refusedReplaces(CONTRACT_FILE, 'blogPost')) {
    await replace(`b22 ${label} is refused (10422 ${rule})`, constraintViolation(rule), { ...data, blogId: id32(ctx.blogId), slug: fixture.slug, publishedAt: fixture.publishedAt });
  }
  await replace('b22a a tombstone that drops publishedAt is refused (40128: frozen once set)', IMMUTABLE_CHANGED, drop(tombstoneData(ctx, fixture), 'publishedAt'));
  await replace('b22b the author\'s tombstone lands: deleted, comments off, blogId/slug/publishedAt kept', null, tombstoneData(ctx, fixture));
  const stored = (await battery.fetchDocument('blogPost', fixture.id))?.toJSON?.() ?? {};
  battery.check('b22c it reads back as a tombstone: no title, no body, the slug kept',
    stored.deleted === true && stored.commentsEnabled === false && stored.title === undefined && stored.data0 === undefined && stored.slug === fixture.slug,
    JSON.stringify({ deleted: stored.deleted, commentsEnabled: stored.commentsEnabled, title: stored.title, slug: stored.slug }));
  await replace('b22d taking the tombstone back is refused (40128: deleted frozen once set)', IMMUTABLE_CHANGED,
    postData({ blogId: id32(ctx.blogId), title: `Back ${run}`, slug: fixture.slug, publishedAt: fixture.publishedAt }));
  await replace('b22e refilling it while flagged is refused (10422 tombstoneIsBlank)', constraintViolation('tombstoneIsBlank'), tombstoneData(ctx, fixture, { title: `Back ${run}` }));
  // The slug stays taken: blogAndSlug is unique, and the link still resolves to the tombstone.
  await battery.probeCreate('b22f a new post reusing the tombstone\'s slug is refused (40105)', DUPLICATE_UNIQUE, author, 'blogPost',
    postData({ blogId: id32(ctx.blogId), title: `Squat ${run}`, slug: fixture.slug }));
  ctx.tombstone = fixture;
}

async function caseB23BarredRetraction(ctx) {
  const { battery, author, moderator, contractId, run } = ctx;
  const { sdk } = battery;
  console.log('\n--- b23. retractedWhen: a banned author tombstones its own post, and nothing else ---');
  const fixture = await tombstoneFixture(ctx, 'b23');
  if (!fixture) return;
  const { replace } = fixture;
  const standing = () => battery.readback(() => sdk.contracts.moderationStatus({ contractId, identityId: author.ownerId, lists: ['banlist'] }));
  try {
    let banned = true;
    try {
      await sdk.contracts.banUser({ identity: moderator.identity, contractId, identityId: author.ownerId, reason: { text: 'b23 battery ban' }, signer: moderator.signer });
    } catch (e) {
      banned = (await standing().catch(() => ({ banned: false }))).banned === true;
      if (!banned) battery.check('b23 the moderator bans the author', false, String(e?.message ?? e).slice(0, 200));
    }
    if (!banned) return;
    battery.check('b23 the moderator bans the author', true);
    await replace('b23a the banned author\'s EDIT is refused (41107: no `deleted`, so not a retraction)', BANNED,
      postData({ blogId: id32(ctx.blogId), title: `Edited ${run}`, slug: fixture.slug, publishedAt: fixture.publishedAt }));
    await replace('b23b a tombstone keeping its title passes the bar and is refused by the rule (10422 tombstoneIsBlank)', constraintViolation('tombstoneIsBlank'),
      tombstoneData(ctx, fixture, { title: `Kept ${run}` }));
    await replace('b23c the banned author\'s tombstone of its own post is ACCEPTED (retractedWhen)', null, tombstoneData(ctx, fixture));
    await battery.probeCreate('b23d a new post by the banned author is still refused (41107)', BANNED, author, 'blogPost',
      postData({ blogId: id32(ctx.blogId), title: `Banned ${run}`, slug: `b23-new-${run}` }));
  } finally {
    const { lifted, detail } = await liftBar({ kind: 'ban', identityId: author.ownerId, contractId,
      lift: () => sdk.contracts.unbanUser({ identity: moderator.identity, contractId, identityId: author.ownerId, signer: moderator.signer }),
      standing });
    battery.check('b23 the moderator unbans the author (the banlist reads clear on repeated polls)', lifted, lifted ? detail : `${detail.slice(0, 200)} — THE AUTHOR MAY STILL BE BANNED; unban by hand`);
  }
}

async function caseB24CommentOnTombstone(ctx) {
  const { battery, reader, run } = ctx;
  console.log('\n--- b24. a tombstone takes no comment (its commentsEnabled is false) ---');
  if (!ctx.tombstone) await caseB22Tombstone(ctx);
  if (!ctx.tombstone) { battery.check('b24 fixture', false, 'no tombstone'); return; }
  const comment = (label, expect, postCommentsEnabled) => battery.probeCreate(label, expect, reader, 'blogComment',
    commentData({ blogPostId: id32(ctx.tombstone.id), content: `${label} ${run}`, postCommentsEnabled }));
  // As b20 on a comments-off post: the honest copy breaks commentsOpen, a lie breaks the agreement.
  await comment('b24a a comment on the tombstone, copying its flag, is refused (10422 commentsOpen)', constraintViolation('commentsOpen'), false);
  await comment('b24b claiming the tombstone takes comments is refused (40127)', PROPERTY_MISMATCH, true);
  await comment('b24c leaving the flag out on the tombstone is refused (40127)', PROPERTY_MISMATCH, undefined);
}

const CASES = new Map([
  ['b1', caseB1Fixtures], ['b2', caseB2BlogRefs], ['b3', caseB3Comments], ['b4', caseB4Counts],
  ['b5', caseB5Rankings], ['b6', caseB6Windowed], ['b7', caseB7Edit], ['b8', caseB8Permanence],
  ['b9', caseB9FeeMismatch], ['b10', caseB10CommentDelete], ['b11', caseB11FollowDelete], ['b12', caseB12Immutable],
  ['b13', caseB13Ban], ['b14', caseB14ModeratorDelete], ['b17', caseB17Warn], ['b18', caseB18TypedLabels],
  ['b19', caseB19PropertyConstraints], ['b20', caseB20CommentsOff], ['b21', caseB21OwnerGate],
  ['b22', caseB22Tombstone], ['b23', caseB23BarredRetraction], ['b24', caseB24CommentOnTombstone],
]);

/** v7 shape the cases rely on beyond the per-type rules selfTestModerated checks. */
function selfTestV7() {
  const indexNames = (docType) => (SCHEMAS[docType].indices ?? []).map((entry) => entry.name);
  const moderators = CONTRACT.config?.moderation?.moderators ?? {};
  const fee = (docType) => actionFeeFor(docType, SCHEMAS)?.moderators;
  return reportSelfTest(`contracts/${CONTRACT_FILE} (blog v7)`, [
    ['moderation is elected, seats contestable, owner protected, interim the contract owner', moderators.$type === 'elected' && moderators.seatContestable === true && moderators.ownerProtected === true && moderators.interim?.$type === 'contractOwner'],
    ['no doctype carries a tokenCost (comments cost no YAPP)', Object.values(SCHEMAS).every((schema) => schema.tokenCost === undefined)],
    ['blog and blogPost creates declare an 80M moderators fee', fee('blog') === 80_000_000n && fee('blogPost') === 80_000_000n],
    ['blogComment creates declare a 16M moderators fee', fee('blogComment') === 16_000_000n],
    ['follows are unpriced', actionFeeFor('blogFollow', SCHEMAS) === null],
    ['blog.timeline and blogPost.timeline index [$createdAt]', ['blog', 'blogPost'].every((t) => JSON.stringify(index(t, 'timeline')?.properties) === '[{"$createdAt":"asc"}]')],
    ['the dropped indexes are gone (blogPost/blogComment ownerAndTime, blogFollow following, the count-only twins)',
      !indexNames('blogPost').includes('ownerAndTime') && !indexNames('blogComment').includes('ownerAndTime') && !indexNames('blogComment').includes('commentCount')
      && !indexNames('blogFollow').includes('following') && !indexNames('blogFollow').includes('followerCount') && !indexNames('blogFollow').includes('followersByDay')],
    ['comment counts ride postAndTime (rangeCountable, b4)', index('blogComment', 'postAndTime')?.rangeCountable === true],
    ['follower counts and "most followed" ride followers (rangeCountable, ranked at blogId; b4c, b5b)', index('blogFollow', 'followers')?.rangeCountable === true && index('blogFollow', 'followers')?.rankedCountable?.at === 'blogId'],
    ['followersTrend and discussedRecent are ranked 72h windows stepping 24h (b5a, b6)', [index('blogFollow', 'followersTrend'), index('blogComment', 'discussedRecent')].every((entry) => entry?.rankedCountable === true && entry.timeRange?.range === 259200 && entry.timeRange?.step === 86400)],
    ['blogPost declares retractedWhen { present: deleted } (b23)', JSON.stringify(SCHEMAS.blogPost.retractedWhen) === '{"present":"deleted"}'],
    ['blogPost requires $updatedAt (publishedNotAhead reads it)', SCHEMAS.blogPost.required.includes('$updatedAt')],
  ]);
}

await runBattery({
  label: 'blog',
  contract: { env: 'BLOG_CONTRACT_ID' },
  cases: CASES,
  actors: { author: 210, reader: 211, stranger: 212 },
  flags: { moderator: { ...MODERATOR_FLAG, default: '260' } },
  selfTest: () => Math.max(selfTestV7(), selfTestModerated(CONTRACT_FILE, {
    // b20: the post's commentsEnabled is copied, and a copy of `false` is refused
    // (beta.6 v5). b4d: the notification key is the post's own $ownerId, derived
    // through blogPostId (v6), so there is no copied owner to forge.
    blogComment: { where: { blogPostId: { commentsEnabled: 'postCommentsEnabled' } }, moderatorDeletable: true, constraints: DECLARED_RULES[CONTRACT_FILE].blogComment },
    // b12: blogId frozen, publishedAt write-once. b15: moderators may remove a post.
    // b18: labels are typed string arrays (beta.4 v4).
    // b19: content chunks are contiguous (beta.5).
    // b21: only the blog's owner posts to it (beta.6 v5).
    // b22: `deleted` is frozen once set (v7), like publishedAt.
    blogPost: { where: { blogId: { $ownerId: '$ownerId' } }, immutable: ['blogId'], immutableWhen: { publishedAt: { present: '$old.publishedAt' }, deleted: { present: '$old.deleted' } }, moderatorDeletable: true, keepsHistory: false, typedArrays: { labels: { items: 'string', maxItems: 16, maxLength: 40 } }, constraints: DECLARED_RULES[CONTRACT_FILE].blogPost },
    blog: { moderatorDeletable: true, keepsHistory: false, typedArrays: { labels: { items: 'string', maxItems: 64, maxLength: 40 } } },
  }, { moderation: { banlist: true, suspensions: true, warnings: true } })),
  // Every create of a priced type (blog, blogPost, blogComment) carries the declared agreement,
  // unless a case opts out (`noAgreement`, b3c) or names its own (`agreement`, b9).
  agreementFor: (sdk, docType) => feeAgreementFor(sdk, docType, SCHEMAS),
  setup: async ({ battery, args }) => {
    const moderator = await battery.moderatorActor(args.moderator);
    console.log(`moderator=${moderator.label}`);
    return { startedAt: Date.now() - 60_000, strangerCommentId: null, draftId: null, publishedAt: null, tombstone: null, moderator };
  },
  summary: (ctx) => `blog=${ctx.blogId} posts=${ctx.post1},${ctx.post2}`,
});
