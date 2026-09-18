/**
 * Offline full-validation parse of a contract JSON against the installed wasm
 * DPP, plus — for the social contract — the structural invariants its shape has
 * to keep. No network, no keys, no broadcast.
 *
 * `DataContract.fromJSON(json, true, <latest>)` runs the same structural parser
 * and meta-schema validation the chain runs, so a grammar mistake (a bad
 * `propertyAgreement` pair, an `immutable` entry naming a system field, a
 * `rangeCountable`/`countable` contradiction) fails here rather than after a
 * funded state transition.
 *
 * The invariants below are the ones the contract was cut to hold and that
 * meta-schema validation does NOT check: which agreements exist and what they
 * bind to, which properties are frozen, and which indexes carry count trees.
 * They are pinned rather than derived — the point is that a hand edit to the
 * JSON has to be a deliberate edit here too.
 *
 * The `id`/`ownerId` are placeholders: neither participates in schema
 * validation, and nothing is signed or published.
 *
 * Run:
 *   node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v7.json
 */
import { readFileSync } from 'node:fs';
import { DataContract, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';

/** Any valid 32-byte identifier; schema validation never looks at it. */
const PLACEHOLDER_ID = '11111111111111111111111111111111';

// ---- Social-contract invariants ---------------------------------------------

/** Every `propertyAgreement` the contract declares, keyed by the referring property. */
const AGREEMENTS = {
  'like.postId': { hashtag: 'hashtag', postAuthor: '$ownerId' },
  'likeReply.replyId': { replyAuthor: '$ownerId' },
  'repost.postId': { postOwnerId: '$ownerId' },
  'beat.postId': { hashtag: 'hashtag' },
};

/** `immutable` / `immutableAllowSetting`, in schema-position order. */
const FROZEN = {
  post: [
    ['language', 'hashtag', 'quotedPostId', 'quotedReplyId', 'quotedPostOwnerId',
      'embedContractId', 'embedDocType', 'embedId', 'deleted'],
    ['deleted'],
  ],
  reply: [['rootPostId', 'replyToReplyId', 'parentOwnerId', 'deleted'], ['deleted']],
  followRequest: [['targetId'], []],
};

/** What a tombstone blanks or drops, so freezing any of it makes tombstoning impossible. */
const TOMBSTONE_BLANKS = ['content', 'mediaUrl', 'sensitive', 'encryptedContent', 'epoch', 'nonce'];

/**
 * Every index, canonicalized as
 * `<doctype>.<name> [prop:dir,…] <flag>=<json> …` with the flags sorted.
 *
 * Pinned in full rather than by individual flag because the contract is frozen:
 * a flipped sort direction, a dropped `terminal`/`unique`/`rangeCountable`/
 * `preallocated`/`skipIfAbsent`, a changed `timeRange` grid or TTL, and an
 * added or removed index all change the string, and the failure prints the
 * exact pair. `rangeCountable: true` implies `countable: "countable"`, so an
 * index carrying both is a contradiction the list would also catch — it is
 * checked separately only to name that rule in the output.
 */
const INDEXES = [
  "beat.byDayHashtagPost [$createdAt:asc,hashtag:asc,postId:asc] rangeCountable=true rankedCountable={\"at\":[\"hashtag\",\"postId\"]} terminal=\"$ownerId\" timeRange={\"on\":\"$createdAt\",\"range\":86400,\"step\":86400,\"ttl\":604800}",
  "beat.byPost [postId:asc] terminal=\"$ownerId\"",
  "beat.byPostTime [postId:asc,$createdAt:asc] terminal=\"$ownerId\"",
  "beat.byRollingHashtagPost [$createdAt:asc,hashtag:asc,postId:asc] rangeCountable=true rankedCountable={\"at\":[\"hashtag\",\"postId\"]} terminal=\"$ownerId\" timeRange={\"on\":\"$createdAt\",\"range\":86400,\"step\":21600,\"ttl\":604800}",
  "block.ownerAndBlocked [$ownerId:asc,blockedId:asc] unique=true",
  "block.ownerBlocks [$ownerId:asc,$createdAt:asc]",
  "blockFilter.owner [$ownerId:asc] unique=true",
  "blockFollow.owner [$ownerId:asc] unique=true",
  "bookmark.ownerAndPost [$ownerId:asc,postId:asc] unique=true",
  "bookmark.ownerBookmarks [$ownerId:asc,$createdAt:asc]",
  "follow.followerCount [followingId:asc] rangeCountable=true rankedCountable=true",
  "follow.followers [followingId:asc,$createdAt:asc]",
  "follow.following [$ownerId:asc,$createdAt:asc]",
  "follow.followingCount [$ownerId:asc] countable=true",
  "follow.ownerAndFollowing [$ownerId:asc,followingId:asc] unique=true",
  "followRequest.target [targetId:asc,$createdAt:asc]",
  "followRequest.targetAndRequester [targetId:asc,$ownerId:asc] unique=true",
  "like.byAuthorPost [postAuthor:asc,postId:asc] preallocated=true rangeCountable=true rankedCountable={\"at\":[\"postAuthor\",\"postId\"]} terminal=\"$ownerId\"",
  "like.byAuthorTimePost [postAuthor:asc,$createdAt:asc,postId:asc] terminal=\"$ownerId\"",
  "like.byDayAuthorPost [$createdAt:asc,postAuthor:asc,postId:asc] rangeCountable=true rankedCountable={\"at\":[\"postAuthor\",\"postId\"]} terminal=\"$ownerId\" timeRange={\"on\":\"$createdAt\",\"range\":86400,\"step\":86400,\"ttl\":604800}",
  "like.byDayPost [$createdAt:asc,postId:asc] rangeCountable=true rankedCountable=true terminal=\"$ownerId\" timeRange={\"on\":\"$createdAt\",\"range\":86400,\"step\":86400,\"ttl\":604800}",
  "like.byHashtagPost [hashtag:asc,postId:asc] preallocated=true rangeCountable=true rankedCountable={\"at\":[\"hashtag\",\"postId\"]} skipIfAbsent=true terminal=\"$ownerId\"",
  "like.byLiker [$ownerId:asc] terminal=\"postId\"",
  "like.byPost [postId:asc] preallocated=true rangeCountable=true rankedCountable=true terminal=\"$ownerId\"",
  "likeReply.byAuthorTimeReply [replyAuthor:asc,$createdAt:asc,replyId:asc] terminal=\"$ownerId\"",
  "likeReply.byLiker [$ownerId:asc] terminal=\"replyId\"",
  "likeReply.byReply [replyId:asc] countable=\"countable\" preallocated=true terminal=\"$ownerId\"",
  "post.byOwner [$ownerId:asc] rangeCountable=true rankedCountable=true",
  "post.languageTimeline [language:asc,$createdAt:asc]",
  "post.ownerAndTime [$ownerId:asc,$createdAt:asc]",
  "post.quoteCount [quotedPostId:asc] countable=true",
  "post.quoteReplyCount [quotedReplyId:asc] countable=true",
  "post.quotedPostOwnerAndTime [quotedPostOwnerId:asc,$createdAt:asc]",
  "post.quotesOfPost [quotedPostId:asc,$createdAt:asc]",
  "post.quotesOfReply [quotedReplyId:asc,$createdAt:asc]",
  "post.tagAndTime [hashtag:asc,$createdAt:asc]",
  "postMention.mentionedUserAndTime [mentionedUserId:asc,$createdAt:asc]",
  "postMention.postAndMentioned [postId:asc,mentionedUserId:asc] unique=true",
  "privateFeedGrant.ownerAndLeaf [$ownerId:asc,leafIndex:asc] unique=true",
  "privateFeedGrant.ownerAndRecipient [$ownerId:asc,recipientId:asc] unique=true",
  "privateFeedRekey.ownerAndEpoch [$ownerId:asc,epoch:asc] unique=true",
  "privateFeedState.owner [$ownerId:asc] unique=true",
  "profile.owner [$ownerId:asc] unique=true",
  "reply.byReplyToReply [replyToReplyId:asc] countable=true",
  "reply.byRoot [rootPostId:asc] countable=true",
  "reply.ownerAndTime [$ownerId:asc,$createdAt:asc]",
  "reply.parentOwnerAndTime [parentOwnerId:asc,$createdAt:asc]",
  "reply.replyToReplyAndTime [replyToReplyId:asc,$createdAt:asc]",
  "reply.rootAndTime [rootPostId:asc,$createdAt:asc]",
  "repost.byPost [postId:asc] countable=true",
  "repost.ownerAndPost [$ownerId:asc,postId:asc] unique=true",
  "repost.ownerAndTime [$ownerId:asc,$createdAt:asc]",
  "repost.postOwnerAndTime [postOwnerId:asc,$createdAt:asc]",
];

/** Per-doctype YAPP create prices. A zeroed cost is the anti-spam bond gone. */
const TOKEN_COSTS = {
  post: { create: { tokenPosition: 0, amount: 10 } },
  reply: { create: { tokenPosition: 0, amount: 3 } },
  like: { create: { tokenPosition: 0, amount: 1 } },
  likeReply: { create: { tokenPosition: 0, amount: 1 } },
  repost: { create: { tokenPosition: 0, amount: 1 } },
};

/** The doctypes the social contract declares. */
const DOCUMENT_TYPES = [
  'beat', 'block', 'blockFilter', 'blockFollow', 'bookmark', 'follow', 'followRequest',
  'like', 'likeReply', 'post', 'postMention', 'privateFeedGrant', 'privateFeedRekey',
  'privateFeedState', 'profile', 'reply', 'repost',
];

/** Doctypes any social contract must declare, used to recognize one. */
const SOCIAL_MARKERS = ['post', 'reply', 'like'];

const IDENTIFIER_MEDIA_TYPE = 'application/x.dash.dpp.identifier';
/** Structural equality, insensitive to object key order (arrays stay ordered). */
const canonical = (_, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
    : value;
const eq = (a, b) => JSON.stringify(a, canonical) === JSON.stringify(b, canonical);

/**
 * Whether `schemas` is the social contract. A file carrying SOME of the marker
 * doctypes but not all of them throws rather than skipping: the invariants
 * below are the whole point of running this on the social contract, and a
 * silent skip on a renamed or dropped doctype would report OK while checking
 * nothing.
 */
function isSocialContract(schemas) {
  const present = SOCIAL_MARKERS.filter((type) => type in schemas);
  if (present.length === 0) return false;
  if (present.length !== SOCIAL_MARKERS.length) {
    throw new Error(
      `this looks like the social contract (it declares ${present.join(', ')}) but is missing ` +
      `${SOCIAL_MARKERS.filter((type) => !(type in schemas)).join(', ')}, so its invariants cannot be checked`
    );
  }
  return true;
}

/**
 * Asserts the invariants the social contract's shape encodes. `contract` is the
 * wasm-parsed form, used to cross-check that the runtime really sees the frozen
 * lists — the raw keywords are present in the JSON below protocol 14 too, but
 * `documentImmutableProperties` is empty there, so a non-empty map is itself
 * the protocol-14 proof.
 */
function socialInvariants(schemas, contract, check) {
  const indices = Object.entries(schemas)
    .flatMap(([type, schema]) => (schema.indices ?? []).map((index) => [`${type}.${index.name}`, index]));

  // ---- propertyAgreement ----------------------------------------------------
  const declared = Object.fromEntries(
    Object.entries(schemas).flatMap(([type, schema]) =>
      Object.entries(schema.properties)
        .filter(([, definition]) => definition.refersTo?.propertyAgreement)
        .map(([name, definition]) => [`${type}.${name}`, definition.refersTo.propertyAgreement]))
  );
  check('every propertyAgreement is exactly the declared set', eq(declared, AGREEMENTS), Object.keys(declared).join(', '));
  // A `$ownerId` KEY would be a writer gate, restricting the write to the
  // referenced post's owner — anyone may like, beat or repost anyone's post.
  check('no agreement declares a writer gate',
    Object.values(declared).every((pairs) => !('$ownerId' in pairs) && !('$creatorId' in pairs)));
  // Not enforced by the meta-schema: a system-field pair yields an identifier,
  // so the referring side has to be one.
  check('every referring side of a system-field pair is an identifier property',
    Object.entries(declared).every(([key, pairs]) => {
      const type = key.split('.')[0];
      return Object.entries(pairs).every(([referring, referenced]) =>
        !referenced.startsWith('$')
        || schemas[type].properties[referring]?.contentMediaType === IDENTIFIER_MEDIA_TYPE);
    }));

  // ---- no client-attested author -------------------------------------------
  // Likes bind to the referenced document's `$ownerId`; a duplicated column
  // consensus could only check against itself must not come back.
  for (const type of ['post', 'reply']) {
    check(`${type} declares no attested author column`,
      !('author' in schemas[type].properties) && !schemas[type].required.includes('author'));
  }
  check('no property description still claims a binding to an attested author',
    !Object.values(schemas).some((schema) =>
      Object.values(schema.properties).some((definition) =>
        /\b(post|reply)\.author\b/.test(definition.description ?? ''))));

  // ---- positions ------------------------------------------------------------
  check('every doctype numbers its top-level positions 0..n-1',
    Object.entries(schemas).every(([, schema]) => {
      const positions = Object.values(schema.properties).map((d) => d.position).sort((a, b) => a - b);
      return eq(positions, positions.map((_, index) => index));
    }));

  // ---- immutable / immutableAllowSetting ------------------------------------
  const freezing = Object.entries(schemas)
    .filter(([, schema]) => schema.immutable || schema.immutableAllowSetting)
    .map(([type, schema]) => [type, [schema.immutable ?? [], schema.immutableAllowSetting ?? []]]);
  check('exactly the declared doctypes freeze properties, with the declared lists',
    eq(Object.fromEntries(freezing), FROZEN), freezing.map(([type]) => type).join(', '));
  for (const [type, [immutable, allowSetting]] of freezing) {
    const schema = schemas[type];
    // `immutable` is only meaningful on a mutable doctype; on an immutable one
    // every property is frozen already.
    check(`${type} is documentsMutable`, schema.documentsMutable !== false);
    check(`${type} freezes only declared, non-system, top-level, unique properties`,
      new Set(immutable).size === immutable.length
      && immutable.every((name) => name in schema.properties && !name.startsWith('$') && !name.includes('.')));
    // An allowance only means anything for an OPTIONAL property: a required one
    // always has a value from creation onward, so the allowance is dead.
    check(`${type} allows setting only immutable, optional properties`,
      allowSetting.every((name) => immutable.includes(name) && !schema.required.includes(name)));
    check(`${type} agrees with the wasm-parsed immutable list`,
      eq([...contract.documentTypeImmutableProperties(type).immutable].sort(), [...immutable].sort()));
  }
  for (const type of ['post', 'reply']) {
    check(`${type} freezes nothing the tombstone has to blank or drop`,
      !schemas[type].immutable.some((name) => TOMBSTONE_BLANKS.includes(name)));
  }

  // ---- indexes, doctypes and prices ------------------------------------------
  const signatures = indices.map(([key, index]) => {
    const properties = index.properties
      .map((property) => Object.entries(property).map(([name, direction]) => `${name}:${direction}`).join(''))
      .join(',');
    const flags = Object.keys(index).filter((k) => k !== 'name' && k !== 'properties').sort()
      .map((k) => `${k}=${JSON.stringify(index[k])}`).join(' ');
    return `${key} [${properties}]${flags ? ` ${flags}` : ''}`;
  }).sort();
  const drifted = [
    ...signatures.filter((signature) => !INDEXES.includes(signature)).map((s) => `+ ${s}`),
    ...INDEXES.filter((signature) => !signatures.includes(signature)).map((s) => `- ${s}`),
  ];
  check('every index matches its pinned signature', drifted.length === 0, drifted.join(' | ').slice(0, 400));
  check('no range-countable index repeats the now-implied explicit countable',
    !indices.some(([, i]) => i.rangeCountable === true && i.countable === 'countable'));
  check('the doctypes are exactly the declared set', eq(Object.keys(schemas).sort(), DOCUMENT_TYPES));
  check('the YAPP create prices are unchanged',
    eq(Object.fromEntries(Object.entries(schemas).filter(([, s]) => s.tokenCost).map(([t, s]) => [t, s.tokenCost])),
      TOKEN_COSTS));
}

async function main() {
  // The wasm module backs every class below; nothing works before it loads.
  await ensureInitialized();
  const file = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('usage: node scripts/validate-contract-offline.mjs <contract.json>');
  const source = JSON.parse(readFileSync(file, 'utf8'));
  const platformVersion = PlatformVersion.latest();

  // The same assembly `scripts/register-social-v3-draft.mjs` publishes with.
  const contract = DataContract.fromJSON({
    $formatVersion: source.$formatVersion ?? '1',
    id: PLACEHOLDER_ID,
    ownerId: PLACEHOLDER_ID,
    version: source.version ?? 1,
    documentSchemas: source.documentSchemas,
    ...(source.config ? { config: source.config } : {}),
    ...(source.tokens ? { tokens: source.tokens } : {}),
  }, true, platformVersion);

  console.log(`OK  ${file} parses under FULL validation`);
  console.log(`    platform version: ${platformVersion.version} (${platformVersion.__type})`);
  console.log(`    document types:   ${Object.keys(source.documentSchemas).length}`);
  console.log(`    freezing types:   ${[...contract.documentImmutableProperties.keys()].join(', ') || '(none)'}`);

  if (!isSocialContract(source.documentSchemas)) return 0;

  console.log('');
  let failures = 0;
  const check = (name, condition, detail = '') => {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
  };
  socialInvariants(source.documentSchemas, contract, check);
  console.log('');
  console.log(failures === 0 ? 'SOCIAL INVARIANTS PASSED' : `${failures} INVARIANT(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

try {
  process.exit(await main());
} catch (error) {
  // WASM rejections arrive as objects whose useful text is on `message`; the
  // default uncaught-exception dump would print the minified bundle instead.
  console.error(`FAIL  ${error?.message ?? error}`);
  if (error?.code !== undefined) console.error(`      consensus code: ${error.code}`);
  process.exit(1);
}
