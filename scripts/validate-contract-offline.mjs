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
 * Indexes carrying a range tree. `rangeCountable: true` implies
 * `countable: "countable"` from 4.2.0-beta.2 on, so pairing them explicitly is
 * redundant and must not reappear.
 */
const RANGE_COUNTABLE = [
  'beat.byDayHashtagPost', 'beat.byRollingHashtagPost', 'follow.followerCount',
  'like.byAuthorPost', 'like.byDayAuthorPost', 'like.byDayPost', 'like.byHashtagPost',
  'like.byPost', 'post.byOwner',
];

/** Indexes countable WITHOUT a range tree, which therefore keep an explicit flag. */
const PLAIN_COUNTABLE = [
  'follow.followingCount=true', 'likeReply.byReply=countable', 'post.quoteCount=true',
  'post.quoteReplyCount=true', 'reply.byReplyToReply=true', 'reply.byRoot=true',
  'repost.byPost=true',
];

const IDENTIFIER_MEDIA_TYPE = 'application/x.dash.dpp.identifier';
/** Structural equality, insensitive to object key order (arrays stay ordered). */
const canonical = (_, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
    : value;
const eq = (a, b) => JSON.stringify(a, canonical) === JSON.stringify(b, canonical);

/** True when `schemas` is the social contract rather than one of the feature contracts. */
function isSocialContract(schemas) {
  return ['post', 'reply', 'like', 'likeReply', 'repost', 'beat'].every((type) => type in schemas);
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

  // ---- count trees ----------------------------------------------------------
  check('the range-countable indexes are exactly the declared set',
    eq(indices.filter(([, i]) => i.rangeCountable === true).map(([key]) => key).sort(), RANGE_COUNTABLE));
  check('no range-countable index repeats the now-implied explicit countable',
    !indices.some(([, i]) => i.rangeCountable === true && i.countable === 'countable'));
  check('the indexes countable WITHOUT a range tree are exactly the declared set',
    eq(indices.filter(([, i]) => i.rangeCountable !== true && i.countable !== undefined)
      .map(([key, i]) => `${key}=${i.countable}`).sort(), PLAIN_COUNTABLE));

  // Preallocation survives an `$ownerId` agreement: an [authorId, postId] path
  // whose authorId agrees with the post's owner is still a pure function of the
  // referenced document.
  check('like.byAuthorPost stays preallocated',
    indices.find(([key]) => key === 'like.byAuthorPost')?.[1].preallocated === true);
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
