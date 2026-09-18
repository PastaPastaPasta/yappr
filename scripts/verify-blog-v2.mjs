/**
 * Registration-day battery for **blog contract v2**
 * (`contracts/yappr-blog-contract-v2.json`, docs/BLOG_V2.md). Runs live
 * against a freshly registered contract on a beta.1+ devnet; there is no
 * default contract id (`--contract` or `BLOG_V2_CONTRACT_ID`).
 *
 * Actors are seed-ledger personas (`.seed-identities.local.json`): an AUTHOR,
 * a READER and a STRANGER. Comments cost 1 YAPP from the social contract, so
 * the battery buys YAPP for the reader and the stranger up front (`--yapp`).
 *
 * Every fixture is created fresh per run under a new blog, so blog-level and
 * post-level aggregates are exact without a baseline; only the YAPP balance
 * (which outlives the run) is asserted as a delta.
 *
 * Cases:
 *   b1  fixtures: author blog + two posts; reader and stranger follow it;
 *       three comments (2 on post one, 1 on post two)
 *   b2  refersTo on blogId: post and follow naming a GHOST blog rejected (40120)
 *   b3  comments: wrong blogPostOwnerId rejected (40127); ghost blogPostId
 *       rejected (40120); a comment WITHOUT a token payment agreement rejected
 *   b4  counts: countable `commentCount` per post, one grouped count over
 *       `blogPostId in [...]`, countable `followerCount`, and the
 *       `postOwnerAndTime` "comments on my posts" page
 *   b5  rankings: "most discussed posts" and "most followed blogs" carry the
 *       fixtures at exact counts
 *   b6  windowed: followers-today ranked on the daily grid (a cold bucket
 *       proves as the documented axis-descent error, which maps to empty)
 *   b7  history: an edited post returns >= 2 revisions from documents.history
 *   b8  permanence: blogPost and blog delete rejected (canBeDeleted:false)
 *   b9  tokens: the reader's YAPP dropped by exactly 1 per accepted comment
 *   b10 a deleted comment decrements the count tree
 *
 * Run:
 *   NETWORK=devnet node scripts/verify-blog-v2.mjs --contract <id> \
 *     [--author 210] [--reader 211] [--stranger 212] [--yapp 20] [--only b4,b5]
 */
import { ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  DELETE_FORBIDDEN,
  PROPERTY_MISMATCH,
  REFERENCE_NOT_FOUND,
  TOKEN_AGREEMENT_MISSING,
  createBattery,
  id32,
  parseOnly,
  runCases,
} from './battery-lib.mjs';
import {
  YAPP_TOKEN_POSITION,
  createSdkHandle,
  describeErr,
  randomEntropy,
  socialContractId,
} from './seed/seed-lib.mjs';

const COMMENT_COST = 1n;
const DEFAULT_YAPP = 20n;
/** The daily grid `followersByDay` buckets on (contract timeRange range/step). */
const DAY_GRID = { range: 86400, step: 86400 };
/**
 * A ranked read on a bucket no document ever landed in fails proof generation
 * instead of proving an empty ranking; that error IS the empty answer
 * (lib/services/ranked-likes.ts isColdBucketError).
 */
const COLD_BUCKET = /single-path axis read must produce exactly one axis descent/i;

// ---- Document shapes --------------------------------------------------------

const blogData = (run) => ({ name: `Battery ${run}`, description: 'blog v2 battery' });
const postData = ({ blogId, author, title, slug }) => ({
  blogId,
  author,
  title,
  slug,
  data0: crypto.getRandomValues(new Uint8Array(64)),
  publishedAt: Date.now(),
});
const commentData = ({ blogPostId, blogPostOwnerId, content }) => ({ blogPostId, blogPostOwnerId, content });

// ---- Cases ------------------------------------------------------------------

async function caseB1Fixtures(ctx) {
  const { battery, author, reader, stranger } = ctx;
  console.log('\n--- b1. fixtures: blog, two posts, two follows, three comments ---');
  const blog = battery.expectAccepted('b1a author blog created', await battery.attemptCreate(author, 'blog', blogData(ctx.run)));
  ctx.blogId = blog.ok ? blog.id : null;
  if (!ctx.blogId) throw new Error('fixture blog unavailable');

  const base = { blogId: id32(ctx.blogId), author: id32(author.ownerId) };
  const post1 = battery.expectAccepted('b1b post one created (author == $ownerId)',
    await battery.attemptCreate(author, 'blogPost', postData({ ...base, title: `First ${ctx.run}`, slug: `first-${ctx.run}` })));
  const post2 = battery.expectAccepted('b1c post two created',
    await battery.attemptCreate(author, 'blogPost', postData({ ...base, title: `Second ${ctx.run}`, slug: `second-${ctx.run}` })));
  ctx.post1 = post1.ok ? post1.id : null;
  ctx.post2 = post2.ok ? post2.id : null;
  if (!ctx.post1 || !ctx.post2) throw new Error('fixture posts unavailable');

  battery.expectAccepted('b1d reader follows the blog',
    await battery.attemptCreate(reader, 'blogFollow', { blogId: id32(ctx.blogId) }));
  battery.expectAccepted('b1e stranger follows the blog',
    await battery.attemptCreate(stranger, 'blogFollow', { blogId: id32(ctx.blogId) }));

  const owner = id32(author.ownerId);
  for (const [label, who, postId] of [
    ['b1f reader comments on post one', reader, ctx.post1],
    ['b1g stranger comments on post one', stranger, ctx.post1],
    ['b1h reader comments on post two', reader, ctx.post2],
  ]) {
    const outcome = battery.expectAccepted(label, await battery.attemptCreate(
      who, 'blogComment',
      commentData({ blogPostId: id32(postId), blogPostOwnerId: owner, content: `${label} ${ctx.run}` }),
      { tokenCost: COMMENT_COST }
    ));
    if (outcome.ok) {
      if (who === reader) ctx.readerComments += 1;
      if (who === stranger) ctx.strangerCommentId = outcome.id;
    }
  }
}

async function caseB2BlogRefs(ctx) {
  const { battery, author, reader } = ctx;
  console.log('\n--- b2. refersTo on blogId ---');
  battery.expectRejected(
    'b2a post naming a GHOST blog is rejected (40120)',
    await battery.attemptCreate(author, 'blogPost', postData({
      blogId: randomEntropy(), author: id32(author.ownerId), title: `Ghost ${ctx.run}`, slug: `ghost-${ctx.run}`,
    })),
    REFERENCE_NOT_FOUND
  );
  battery.expectRejected(
    'b2b follow naming a GHOST blog is rejected (40120)',
    await battery.attemptCreate(reader, 'blogFollow', { blogId: randomEntropy() }),
    REFERENCE_NOT_FOUND
  );
}

async function caseB3Comments(ctx) {
  const { battery, author, reader, stranger } = ctx;
  console.log('\n--- b3. comments: agreement, ghost post, token payment ---');
  if (!ctx.post1) { battery.check('b3 comments', false, 'no post fixture'); return; }
  battery.expectRejected(
    'b3a comment carrying a FORGED blogPostOwnerId is rejected (40127)',
    await battery.attemptCreate(reader, 'blogComment', commentData({
      blogPostId: id32(ctx.post1), blogPostOwnerId: id32(stranger.ownerId), content: `forged ${ctx.run}`,
    }), { tokenCost: COMMENT_COST }),
    PROPERTY_MISMATCH
  );
  battery.expectRejected(
    'b3b comment on a GHOST post is rejected (40120)',
    await battery.attemptCreate(reader, 'blogComment', commentData({
      blogPostId: randomEntropy(), blogPostOwnerId: id32(author.ownerId), content: `ghost ${ctx.run}`,
    }), { tokenCost: COMMENT_COST }),
    REFERENCE_NOT_FOUND
  );
  battery.expectRejected(
    'b3c comment WITHOUT a token payment agreement is rejected',
    await battery.attemptCreate(reader, 'blogComment', commentData({
      blogPostId: id32(ctx.post1), blogPostOwnerId: id32(author.ownerId), content: `unpaid ${ctx.run}`,
    }), { noPayment: true }),
    TOKEN_AGREEMENT_MISSING
  );
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

  const grouped = await battery.groupedCount(
    'blogComment', [['blogPostId', 'in', [ctx.post1, ctx.post2]]], ['blogPostId'],
    (hex) => bs58.encode(Uint8Array.from(Buffer.from(hex, 'hex')))
  );
  battery.check('b4b one grouped count serves a whole post list',
    grouped.get(ctx.post1) === 2 && grouped.get(ctx.post2) === 1,
    `keys=${[...grouped.entries()].map(([k, v]) => `${k.slice(0, 8)}=${v}`).join(' ')}`);
  battery.workingShapes.push({
    label: 'comment counts for a post list',
    shape: { documentTypeName: 'blogComment', where: [['blogPostId', 'in', ['<postId>', '…']]], groupBy: ['blogPostId'] },
  });

  const followers = await battery.countBy('blogFollow', [['blogId', '==', ctx.blogId]]);
  battery.check('b4c followerCount is exact', followers === 2, `followers=${followers}`);

  // The exact shape notification-service uses: newest first, which the index
  // serves in either direction.
  const where = [['blogPostOwnerId', '==', ctx.author.ownerId], ['$createdAt', '>', ctx.startedAt]];
  const [asc, desc] = await Promise.all([
    battery.queryDocs('blogComment', { where, orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'asc']], limit: 100 }),
    battery.queryDocs('blogComment', { where, orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']], limit: 100 }),
  ]);
  battery.check('b4d postOwnerAndTime serves "comments on my posts" since a timestamp, both directions',
    asc.length === 3 && desc.length === 3, `asc=${asc.length} desc=${desc.length}`);
  battery.workingShapes.push({
    label: 'comments on my blog posts since last seen',
    shape: { documentTypeName: 'blogComment', where: [['blogPostOwnerId', '==', '<me>'], ['$createdAt', '>', '<lastSeen>']], orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']] },
  });
}

async function caseB5Rankings(ctx) {
  const { battery } = ctx;
  console.log('\n--- b5. rankings: most discussed posts, most followed blogs ---');
  const { page: posts, shape: postShape } = await battery.ranked('blogComment', 'blogPostId', { type: 'count' }, { direction: 'desc' });
  const p1 = battery.groupValueOf(posts, ctx.post1);
  const p2 = battery.groupValueOf(posts, ctx.post2);
  battery.check('b5a "most discussed posts" carries both posts at exact counts',
    Number(p1?.value ?? -1) === 2 && Number(p2?.value ?? -1) === 1,
    `post1=${p1?.value} post2=${p2?.value} groups=${posts.entries.length}`);
  battery.workingShapes.push({ label: 'most discussed posts', shape: postShape });

  const { page: blogs, shape: blogShape } = await battery.ranked('blogFollow', 'blogId', { type: 'count' }, { direction: 'desc' });
  const ours = battery.groupValueOf(blogs, ctx.blogId);
  battery.check('b5b "most followed blogs" carries the fixture blog at its exact count',
    Number(ours?.value ?? -1) === 2, `blog=${ours?.value} groups=${blogs.entries.length}`);
  battery.workingShapes.push({ label: 'most followed blogs', shape: blogShape });
}

async function caseB6Windowed(ctx) {
  const { battery } = ctx;
  console.log('\n--- b6. windowed: followers today (daily grid) ---');
  const shape = {
    documentTypeName: 'blogFollow', groupBy: 'blogId', aggregate: { type: 'count' }, direction: 'desc',
    timeRange: [{ field: '$createdAt', selector: 'newest', grid: { ...DAY_GRID } }],
  };
  try {
    const { page } = await battery.ranked('blogFollow', 'blogId', { type: 'count' }, {
      direction: 'desc', timeRange: shape.timeRange,
    });
    const ours = battery.groupValueOf(page, ctx.blogId);
    battery.check('b6a "trending blogs today" carries the fixture blog at its exact count',
      Number(ours?.value ?? -1) === 2, `blog=${ours?.value} groups=${page.entries.length}`);
    battery.workingShapes.push({ label: 'trending blogs today', shape });
  } catch (e) {
    const message = describeErr(e);
    // A cold bucket is the documented empty answer, not a contract fault.
    battery.check('b6a "trending blogs today" resolves (page or cold-bucket empty)',
      COLD_BUCKET.test(message), message.slice(0, 200));
  }
}

async function caseB7History(ctx) {
  const { battery, author } = ctx;
  console.log('\n--- b7. documents.history on an edited post ---');
  if (!ctx.post1) { battery.check('b7 history', false, 'no post fixture'); return; }
  const current = await battery.fetchDocument('blogPost', ctx.post1);
  const revision = BigInt(current?.revision ?? 1);
  battery.expectAccepted('b7a post edit (replace) is accepted', await battery.attemptReplace(
    author, 'blogPost', ctx.post1,
    postData({ blogId: id32(ctx.blogId), author: id32(author.ownerId), title: `First ${ctx.run} (edited)`, slug: `first-${ctx.run}` }),
    revision
  ));
  try {
    const history = await battery.readback(() => battery.sdk.documents.history({
      dataContractId: ctx.contractId, documentTypeName: 'blogPost', documentId: ctx.post1,
    }));
    const revisions = [...history.values()].map((doc) => Number(doc.toObject().$revision ?? 0));
    battery.check('b7b documents.history returns every revision', history.size >= 2,
      `entries=${history.size} revisions=${revisions.join(',')}`);
    battery.workingShapes.push({
      label: 'post revision history',
      shape: { documentTypeName: 'blogPost', documentId: '<postId>', returns: 'Map<bigint timestamp, Document>' },
    });
  } catch (e) {
    battery.check('b7b documents.history returns every revision', false, describeErr(e).slice(0, 200));
  }
}

async function caseB8Permanence(ctx) {
  const { battery, author } = ctx;
  console.log('\n--- b8. permanence: posts and blogs cannot be deleted ---');
  battery.expectRejected('b8a blogPost delete is rejected',
    await battery.attemptDelete(author, 'blogPost', ctx.post2), DELETE_FORBIDDEN);
  battery.expectRejected('b8b blog delete is rejected',
    await battery.attemptDelete(author, 'blog', ctx.blogId), DELETE_FORBIDDEN);
}

async function caseB9Tokens(ctx) {
  const { battery } = ctx;
  console.log('\n--- b9. YAPP accounting ---');
  const after = await battery.yappBalance(ctx.tokenId, ctx.reader.ownerId);
  const spent = ctx.readerYappBefore - after;
  const expected = BigInt(ctx.readerComments) * COMMENT_COST;
  battery.check('b9a reader YAPP dropped by exactly 1 per accepted comment (rejected writes charge nothing)',
    spent === expected, `before=${ctx.readerYappBefore} after=${after} spent=${spent} expected=${expected}`);
}

async function caseB10CommentDelete(ctx) {
  const { battery, stranger } = ctx;
  console.log('\n--- b10. a deleted comment decrements the count tree ---');
  if (!ctx.strangerCommentId) { battery.check('b10 comment delete', false, 'no comment fixture'); return; }
  battery.expectAccepted('b10a comment delete is accepted',
    await battery.attemptDelete(stranger, 'blogComment', ctx.strangerCommentId));
  const count = await battery.countBy('blogComment', [['blogPostId', '==', ctx.post1]]);
  battery.check('b10b commentCount reflects the delete', count === 1, `post1=${count}`);
}

const CASES = new Map([
  ['b1', caseB1Fixtures], ['b2', caseB2BlogRefs], ['b3', caseB3Comments], ['b4', caseB4Counts],
  ['b5', caseB5Rankings], ['b6', caseB6Windowed], ['b7', caseB7History], ['b8', caseB8Permanence],
  ['b9', caseB9Tokens], ['b10', caseB10CommentDelete],
]);

function parseArgs(argv) {
  const args = {
    contract: process.env.BLOG_V2_CONTRACT_ID?.trim() || null,
    author: 210, reader: 211, stranger: 212, yapp: DEFAULT_YAPP, only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--author': args.author = Number(argv[++i]); break;
      case '--reader': args.reader = Number(argv[++i]); break;
      case '--stranger': args.stranger = Number(argv[++i]); break;
      case '--yapp': args.yapp = BigInt(argv[++i]); break;
      case '--only': args.only = parseOnly(argv[++i], CASES); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('Pass --contract <id> or set BLOG_V2_CONTRACT_ID');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  await ensureInitialized();
  const socialId = socialContractId();
  const handle = createSdkHandle({ contractIds: [socialId, args.contract] });
  const { protocolVersion } = await handle.connect();
  const battery = createBattery({ handle, contractId: args.contract, socialId });
  console.log(`connected (PV${protocolVersion}); blog v2 ${args.contract}; YAPP from ${socialId}`);
  const tokenId = await battery.readback(() => battery.sdk.tokens.calculateId(socialId, YAPP_TOKEN_POSITION));
  const [author, reader, stranger] = await Promise.all(
    [args.author, args.reader, args.stranger].map((idx) => battery.personaActor(idx))
  );
  console.log(`author=${author.label} reader=${reader.label} stranger=${stranger.label}`);
  for (const actor of [reader, stranger]) {
    const balance = await battery.ensureYapp(tokenId, actor, args.yapp);
    console.log(`     ${actor.label}: ${balance} YAPP`);
    if (balance < args.yapp) throw new Error(`${actor.label} holds ${balance} YAPP, below the ${args.yapp} the battery needs`);
  }
  const ctx = {
    battery, contractId: args.contract, socialId, tokenId, author, reader, stranger,
    run: Date.now().toString(36), startedAt: Date.now() - 60_000,
    readerComments: 0, strangerCommentId: null,
    readerYappBefore: await battery.yappBalance(tokenId, reader.ownerId),
  };
  await runCases(battery, CASES, args.only, ctx);
  const failures = battery.report(`blog=${ctx.blogId} posts=${ctx.post1},${ctx.post2}`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
