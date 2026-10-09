/**
 * The `propertyConstraints` rules Yappr's contracts declare, and the documents
 * each must accept and refuse (DocumentPropertyConstraintViolated, 10422).
 * docs/CONTRACTS_BETA5.md explains the beta.5 rules, docs/CONTRACTS_BETA6.md
 * the beta.6 ones (blog `commentsOpen`) and docs/SOCIAL_V10.md the beta.7 ones
 * (social v10 drops the tombstone rule and adds report `resolvedHasStatus`;
 * storefront `storeIsOpen`, QA D-25). Blog v7 (5.0.0-beta.2) adds the post
 * tombstone (`hasBody`, `tombstoneIsBlank`) and `publishedNotAhead`.
 *
 * One table, two consumers:
 *   - `validate-contract-offline.mjs --constraints` runs every case through
 *     rs-dpp's own rule evaluation offline (the wasm-sdk's
 *     `DataContract.checkDocumentPropertyConstraints`, the check the node runs
 *     on a create or replace), so a rule that drifts from its cases fails
 *     before anything is registered;
 *   - the live batteries (verify-v10 c1 and r1, verify-storefront s20,
 *     verify-pollr p10, verify-blog b19) broadcast the refused create cases against the
 *     registered contract; their existing fixtures are the accepted side.
 *
 * `data` holds only the properties a rule reads plus what the schema requires;
 * the builders below fill in the rest. Byte fields are fresh random bytes, so
 * nothing here names a real document.
 */

const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const id = () => bytes(32);

/** Every rule name a contract declares, keyed by file then doctype: the self-tests pin these. */
export const DECLARED_RULES = {
  'yappr-social-contract-v10.json': {
    post: ['embedAllOrNone', 'notEmpty', 'oneQuoteTarget', 'privateAllOrNone', 'privateHasNoMedia', 'quoteNamesOwner'],
    reply: ['privateAllOrNone', 'privateHasNoMedia'],
    report: ['oneTarget', 'otherHasNote', 'resolvedHasStatus'],
  },
  'yappr-storefront-contract.json': {
    storeItem: ['pricedHasCurrency', 'onePrice', 'oneStock', 'optionTable', 'comboTable', 'comboStocks', 'comboSkus', 'comboWeights', 'comboImages'],
    shippingZone: ['flatRateHasCurrency', 'tieredHasTiers'],
    storeOrder: ['storeIsOpen'],
  },
  'pollr-contract.json': {
    poll: ['endsAfterCreation', 'endsWithin31Days', 'optionCountMatches'],
    vote: ['choiceIsAnOption', 'multiChoiceIsSlot', 'singleUsesSlotZero', 'slotIsAnOption', 'writtenBeforeClose'],
  },
  'yappr-blog-contract.json': { blogPost: ['chunksContiguous', 'hasBody', 'tombstoneIsBlank', 'publishedNotAhead'], blogComment: ['commentsOpen'] },
};

// ---- Base documents (valid under every rule) --------------------------------

export const basePost = () => ({ content: 'constraint probe' });
export const baseReply = () => ({ content: 'constraint probe', rootPostId: id(), parentOwnerId: id() });
/** Reason 0 is spam; 8 is "something else", which must say what. */
export const baseReport = () => ({ postId: id(), targetOwnerId: id(), reason: 0 });
const privateFields = () => ({ encryptedContent: bytes(48), keyGeneration: 1, nonce: bytes(24) });
const embed = () => ({ embedContractId: id(), embedDocType: 'poll', embedId: id() });
/** v10: a mediaUrl needs its hash and fingerprint (dependentRequired, 10101 before any rule runs). */
const media = (mediaUrl) => ({ mediaUrl, mediaHash: bytes(32), mediaFingerprint: bytes(8) });
export const baseOrder = () => ({ storeId: id(), sellerId: id(), encryptedPayload: bytes(64), nonce: bytes(24), storeStatus: 'active' });
export const baseItem = () => ({ storeId: id(), title: 'constraint probe', status: 'active' });
export const baseZone = () => ({ storeId: id(), name: 'constraint probe', rateType: 'flat' });
/**
 * Storefront v7: a variants table of 2 colours × 2 sizes, every list aligned.
 * A selector names one option id per axis, in axis order.
 */
export const baseVariants = (extra = {}) => ({
  axes: ['Color', 'Size'],
  options: ['Red', 'Blue', 'S', 'L'],
  optionIds: [1, 2, 3, 4],
  optionAxes: [0, 0, 1, 1],
  nextOptionId: 5,
  selectors: [Uint8Array.of(1, 3), Uint8Array.of(1, 4), Uint8Array.of(2, 3), Uint8Array.of(2, 4)],
  prices: [100, 120, 100, 120],
  ...extra,
});
/** Storefront v7: a variant item (no basePrice, no stockQuantity) priced in `currency`. */
export const variantItem = (variants = baseVariants(), currency = 'USD') => ({ ...baseItem(), currency, variants });
/**
 * Storefront v7 at its caps: 5 axes of 4 options and 256 combinations, with
 * stock, SKU, weight and image lists. The JSON schema allows it; whether the
 * whole create fits one state transition is the client's budget.
 */
export const fullVariants = () => {
  const optionIds = Array.from({ length: 20 }, (_, i) => i + 1);
  const selectors = [];
  for (let n = 0; n < 256; n += 1) {
    selectors.push(Uint8Array.from([0, 1, 2, 3, 4].map((axis) => axis * 4 + ((n >> (axis * 2)) % 4) + 1)));
  }
  return {
    axes: ['A', 'B', 'C', 'D', 'E'],
    options: optionIds.map((option) => `o${option}`),
    optionIds,
    optionAxes: optionIds.map((option) => Math.floor((option - 1) / 4)),
    nextOptionId: 21,
    selectors,
    prices: selectors.map((_, n) => 100 + n),
    stocks: selectors.map(() => 4294967295),
    skus: selectors.map((_, n) => `SKU-${n}`),
    weights: selectors.map(() => 250),
    images: selectors.map((_, n) => n % 13),
  };
};
/**
 * The instant every case is judged at. The pollr rules read `$createdAt` and
 * `$updatedAt`, so a case fixes both (through its `at` option) relative to
 * this one clock reading; cases that set no `at` are judged at it too.
 */
export const CASE_NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Pollr v5: a three-option single-choice poll closing in a day. */
export const basePoll = () => ({ question: 'constraint probe?', options: ['a', 'b', 'c'], optionCount: 3, multiChoice: false, endsAt: CASE_NOW + DAY });
/** A single-choice ballot (slot 0) for option 1, on a poll closing in an hour. */
const singleBallot = (fields = {}) => ({ pollId: id(), slot: 0, choice: 1, pollOptionCount: 3, pollMultiChoice: false, pollEndsAt: CASE_NOW + HOUR, ...fields });
/** A multi-choice ballot ticking option 2 (slot 2), on a poll closing in an hour. */
const multiBallot = (fields = {}) => ({ pollId: id(), slot: 2, choice: 2, pollOptionCount: 3, pollMultiChoice: true, pollEndsAt: CASE_NOW + HOUR, ...fields });
/** A later write of a ballot: `$revision` 2+ and its own block time. */
const replaced = (revision = 2n, created = CASE_NOW - HOUR) => ({ replace: true, at: { createdAt: created, updatedAt: CASE_NOW, revision } });
/** Blog v6 derives the post owner through blogPostId; there is no blogPostOwnerId to send. */
export const baseComment = () => ({ blogPostId: id(), content: 'constraint probe' });
export const baseBlogPost = () => ({ blogId: id(), title: 'constraint probe', slug: 'constraint-probe', data0: bytes(16) });
/**
 * Blog v7: an author's delete. `deleted` and comments off, every content field
 * absent; `blogId` and `slug` (and `publishedAt`, when the post had one) stay.
 * Written by a replace, so its cases are marked `replace: true`.
 */
export const blogTombstone = (extra = {}) => ({ blogId: id(), slug: 'constraint-probe', deleted: true, commentsEnabled: false, ...extra });
/** `publishedNotAhead` judges `publishedAt` against `$updatedAt`, which the oracle sets to the clock. */
const BLOG_NOW = Date.now();

export const drop = (fields, ...names) => Object.fromEntries(Object.entries(fields).filter(([key]) => !names.includes(key)));

/**
 * [label, docType, data, refusedBy, options] — `refusedBy` is the rule the
 * document breaks, or null when it must be accepted. `options.replace` marks a
 * shape only a later write produces (a moderator's field change, a changed
 * ballot); the offline oracle validates it the same way, because the node runs
 * the rules against the whole changed document. `options.at` fixes the
 * document's `$createdAt`, `$updatedAt` and `$revision` (default: CASE_NOW,
 * CASE_NOW, 1). `options.offlineOnly` keeps a case out of the live batteries.
 */
export const CONSTRAINT_CASES = {
  'yappr-social-contract-v10.json': [
    ['post: a public post', 'post', basePost(), null],
    ['post: a private post (all three encryption fields, teaser)', 'post', { ...basePost(), content: '🔒', ...privateFields() }, null],
    ['post: ciphertext without its nonce', 'post', { ...basePost(), ...drop(privateFields(), 'nonce') }, 'privateAllOrNone'],
    ['post: a keyGeneration alone', 'post', { ...basePost(), keyGeneration: 3 }, 'privateAllOrNone'],
    ['post: a private post carrying media', 'post', { ...basePost(), ...privateFields(), ...media('https://example.com/a.png') }, 'privateHasNoMedia'],
    ['post: a poll embed (all three fields)', 'post', { ...basePost(), ...embed() }, null],
    ['post: an embed missing its doc type', 'post', { ...basePost(), ...drop(embed(), 'embedDocType') }, 'embedAllOrNone'],
    ['post: a quote with its owner', 'post', { ...basePost(), quotedPostId: id(), quotedPostOwnerId: id() }, null],
    ['post: a reply quote with its owner', 'post', { ...basePost(), quotedReplyId: id(), quotedPostOwnerId: id() }, null],
    ['post: a quote naming no owner', 'post', { ...basePost(), quotedPostId: id() }, 'quoteNamesOwner'],
    ['post: quoting a post AND a reply', 'post', { ...basePost(), quotedPostId: id(), quotedReplyId: id(), quotedPostOwnerId: id() }, 'oneQuoteTarget'],
    // notEmpty (v10): a repost is a quote with no content; a post must carry
    // text, ciphertext, media, an embed or a quote.
    ['post: a bare repost (quote, no content)', 'post', { quotedPostId: id(), quotedPostOwnerId: id() }, null],
    ['post: a bare repost of a reply', 'post', { quotedReplyId: id(), quotedPostOwnerId: id() }, null],
    ['post: nothing at all', 'post', {}, 'notEmpty'],
    ['post: an empty content string alone', 'post', { content: '' }, 'notEmpty'],
    ['post: only a hashtag and the sensitive flag', 'post', { hashtag: 'dash', sensitive: true }, 'notEmpty'],
    ['post: media with no text', 'post', { ...media('https://example.com/a.png') }, null],
    ['post: an embed with no text', 'post', { ...embed() }, null],
    ['post: a private post with no teaser (ciphertext is content)', 'post', { ...privateFields() }, null],
    ['reply: a public reply', 'reply', baseReply(), null],
    ['reply: a private reply', 'reply', { ...baseReply(), content: '🔒', ...privateFields() }, null],
    ['reply: a nonce alone', 'reply', { ...baseReply(), nonce: bytes(24) }, 'privateAllOrNone'],
    ['reply: a private reply carrying media', 'reply', { ...baseReply(), ...privateFields(), ...media('ipfs://bafy') }, 'privateHasNoMedia'],
    ['report: a post report', 'report', baseReport(), null],
    ['report: a reply report', 'report', { ...drop(baseReport(), 'postId'), replyId: id() }, null],
    ['report: "something else" saying what', 'report', { ...baseReport(), reason: 8, note: 'constraint probe' }, null],
    ['report: naming a post AND a reply', 'report', { ...baseReport(), replyId: id() }, 'oneTarget'],
    ['report: naming neither', 'report', drop(baseReport(), 'postId'), 'oneTarget'],
    ['report: "something else" with no note', 'report', { ...baseReport(), reason: 8 }, 'otherHasNote'],
    // status/resolution are written by the moderators' changeDocumentFields, which
    // runs the type's rules on the changed document; the offline oracle judges the
    // same whole document. A reporter setting either is 41124 before any rule runs.
    ['report: handled with a status and a resolution', 'report', { ...baseReport(), status: 2, resolution: 'post removed' }, null, { replace: true }],
    ['report: handled with a status alone', 'report', { ...baseReport(), status: 1 }, null, { replace: true }],
    ['report: a resolution with no status', 'report', { ...baseReport(), resolution: 'looked at it' }, 'resolvedHasStatus', { replace: true }],
  ],
  'yappr-storefront-contract.json': [
    ['storeItem: priced with a currency', 'storeItem', { ...baseItem(), basePrice: 1000, currency: 'USD' }, null],
    ['storeItem: unpriced (no price, no variants)', 'storeItem', baseItem(), null],
    ['storeItem: variants with a currency', 'storeItem', variantItem(baseVariants(), 'EUR'), null],
    ['storeItem: a price with no currency', 'storeItem', { ...baseItem(), basePrice: 1000 }, 'pricedHasCurrency'],
    ['storeItem: variants with no currency', 'storeItem', { ...baseItem(), variants: baseVariants() }, 'pricedHasCurrency'],
    // Storefront v7: the variants table (docs/STOREFRONT_V7.md). Each column
    // stays aligned with its table, and a variant item carries no item-level
    // price or stock.
    ['storeItem: variants with stock, SKU, weight and image lists', 'storeItem', variantItem(baseVariants({ stocks: [5, 0, 2, 9], skus: ['R-S', 'R-L', '', 'B-L'], weights: [100, 180, 100, 180], images: [1, 1, 2, 0] })), null],
    ['storeItem: variants at the caps (5 axes, 256 combinations, every list)', 'storeItem', variantItem(fullVariants(), 'DASH'), null],
    ['storeItem: variants and a basePrice', 'storeItem', { ...variantItem(), basePrice: 1000 }, 'onePrice'],
    ['storeItem: variants and an item stockQuantity', 'storeItem', { ...variantItem(), stockQuantity: 4 }, 'oneStock'],
    ['storeItem: variants with an item SKU and weight (a parent SKU, a default weight)', 'storeItem', { ...variantItem(), sku: 'TEE', weight: 200 }, null],
    ['storeItem: an option with no id', 'storeItem', variantItem(baseVariants({ optionIds: [1, 2, 3] })), 'optionTable'],
    ['storeItem: an option with no axis', 'storeItem', variantItem(baseVariants({ optionAxes: [0, 0, 1] })), 'optionTable'],
    ['storeItem: a combination with no price', 'storeItem', variantItem(baseVariants({ prices: [100, 120, 100] })), 'comboTable'],
    ['storeItem: a price with no combination', 'storeItem', variantItem(baseVariants({ prices: [100, 120, 100, 120, 140] })), 'comboTable'],
    ['storeItem: a stock list one short', 'storeItem', variantItem(baseVariants({ stocks: [5, 0, 2] })), 'comboStocks'],
    ['storeItem: a SKU list one short', 'storeItem', variantItem(baseVariants({ skus: ['a', 'b', 'c'] })), 'comboSkus'],
    ['storeItem: a weight list one long', 'storeItem', variantItem(baseVariants({ weights: [1, 2, 3, 4, 5] })), 'comboWeights'],
    ['storeItem: an image list one short', 'storeItem', variantItem(baseVariants({ images: [1, 1, 2] })), 'comboImages'],
    ['shippingZone: flat with rate and currency', 'shippingZone', { ...baseZone(), flatRate: 500, currency: 'USD' }, null],
    ['shippingZone: flat with no rate (free shipping)', 'shippingZone', baseZone(), null],
    ['shippingZone: flat carrying a pricing config in tiers', 'shippingZone', { ...baseZone(), flatRate: 0, currency: 'USD', tiers: '{"weightRate":10}' }, null],
    ['shippingZone: weight_tiered with tiers', 'shippingZone', { ...baseZone(), rateType: 'weight_tiered', tiers: '[]', currency: 'USD' }, null],
    ['shippingZone: a flat rate with no currency', 'shippingZone', { ...baseZone(), flatRate: 500 }, 'flatRateHasCurrency'],
    ['shippingZone: weight_tiered with no tiers', 'shippingZone', { ...baseZone(), rateType: 'weight_tiered' }, 'tieredHasTiers'],
    ['shippingZone: price_tiered with no tiers', 'shippingZone', { ...baseZone(), rateType: 'price_tiered', flatRate: 100, currency: 'USD' }, 'tieredHasTiers'],
    // QA D-25: storeStatus copies the store's status through the storeId agreement
    // (40127 on a mismatch), so the rule judges the store's own status.
    ['storeOrder: at an active store', 'storeOrder', baseOrder(), null],
    ['storeOrder: at a paused store', 'storeOrder', { ...baseOrder(), storeStatus: 'paused' }, 'storeIsOpen'],
    ['storeOrder: at a closed store', 'storeOrder', { ...baseOrder(), storeStatus: 'closed' }, 'storeIsOpen'],
    // Storefront v6 (the mainnet re-cut) kept these rules; its new shapes must
    // still pass them: a digital product and an order payload at the 5,120 B cap.
    ['storeItem: a digital product priced with a currency', 'storeItem', { ...baseItem(), basePrice: 1000, currency: 'USD', fulfillment: 'digital' }, null],
    ['storeItem: a digital product priced with no currency', 'storeItem', { ...baseItem(), basePrice: 1000, fulfillment: 'digital' }, 'pricedHasCurrency'],
    ['storeItem: a digital product with variants', 'storeItem', { ...variantItem(), fulfillment: 'digital' }, null],
    ['storeItem: a price at 2^53-1 with a currency', 'storeItem', { ...baseItem(), basePrice: Number.MAX_SAFE_INTEGER, currency: 'DASH' }, null],
    ['storeOrder: a 5,120 B payload at an active store', 'storeOrder', { ...baseOrder(), encryptedPayload: bytes(5120) }, null],
  ],
  // Pollr v5 (docs/NON_SOCIAL_CONTRACTS.md). The offline check judges system
  // times by what the case says, so "after close" is a pollEndsAt in the past.
  // `offlineOnly` marks a case a live create cannot reproduce: one the JSON
  // schema refuses before any rule runs, or one whose margin is a single
  // millisecond of block time.
  'pollr-contract.json': [
    ['poll: closes in 1 day', 'poll', basePoll(), null],
    ['poll: closes in exactly 31 days', 'poll', { ...basePoll(), endsAt: CASE_NOW + 31 * DAY }, null],
    ['poll: ten options', 'poll', { ...basePoll(), options: Array.from({ length: 10 }, (_, i) => `o${i}`), optionCount: 10 }, null],
    ['poll: closes in 31 days + 1 ms', 'poll', { ...basePoll(), endsAt: CASE_NOW + 31 * DAY + 1 }, 'endsWithin31Days', { offlineOnly: true }],
    ['poll: no endsAt (the schema requires it; the rules alone refuse it too)', 'poll', drop(basePoll(), 'endsAt'), 'endsAfterCreation', { offlineOnly: true }],
    ['poll: optionCount disagrees with options', 'poll', { ...basePoll(), optionCount: 2 }, 'optionCountMatches'],
    ['poll: born closed', 'poll', { ...basePoll(), endsAt: CASE_NOW - 1000 }, 'endsAfterCreation'],
    ['vote: single, created before close', 'vote', singleBallot(), null],
    ['vote: single, created after close', 'vote', singleBallot({ pollEndsAt: CASE_NOW - HOUR }), 'writtenBeforeClose'],
    ['vote: single, choice changed before close', 'vote', singleBallot({ choice: 2 }), null, replaced()],
    ['vote: single, choice changed after close', 'vote', singleBallot({ choice: 2, pollEndsAt: CASE_NOW - HOUR }), 'writtenBeforeClose', replaced(2n, CASE_NOW - 2 * HOUR)],
    ['vote: single, withdrawn (choice dropped) before close', 'vote', drop(singleBallot(), 'choice'), null, replaced()],
    ['vote: single, withdrawn after close', 'vote', drop(singleBallot({ pollEndsAt: CASE_NOW - HOUR }), 'choice'), 'writtenBeforeClose', replaced()],
    ['vote: no pollEndsAt', 'vote', drop(singleBallot(), 'pollEndsAt'), 'writtenBeforeClose', { offlineOnly: true }],
    ['vote: single, choice past the options', 'vote', singleBallot({ choice: 3 }), 'choiceIsAnOption'],
    ['vote: single, a second ballot (slot 2)', 'vote', singleBallot({ slot: 2, choice: 2 }), 'singleUsesSlotZero'],
    ['vote: multi, option 2 ticked (slot 2)', 'vote', multiBallot(), null],
    ['vote: multi, unticked (choice dropped) before close', 'vote', drop(multiBallot(), 'choice'), null, replaced()],
    ['vote: multi, re-ticked after close', 'vote', multiBallot({ pollEndsAt: CASE_NOW - HOUR }), 'writtenBeforeClose', replaced(3n)],
    ['vote: multi, slot 2 holding choice 1', 'vote', multiBallot({ choice: 1 }), 'multiChoiceIsSlot'],
    ['vote: multi, slot past the options', 'vote', drop(multiBallot({ slot: 5 }), 'choice'), 'slotIsAnOption'],
  ],
  'yappr-blog-contract.json': [
    ['blogPost: one chunk', 'blogPost', baseBlogPost(), null],
    ['blogPost: four chunks', 'blogPost', { ...baseBlogPost(), data1: bytes(8), data2: bytes(8), data3: bytes(8) }, null],
    ['blogPost: data2 with no data1', 'blogPost', { ...baseBlogPost(), data2: bytes(8) }, 'chunksContiguous'],
    ['blogPost: data3 with no data2', 'blogPost', { ...baseBlogPost(), data1: bytes(8), data3: bytes(8) }, 'chunksContiguous'],
    // postCommentsEnabled copies the post's commentsEnabled through the blogPostId
    // agreement (40127 on a mismatch), so the rule judges the post's own flag.
    ['blogComment: on a post that leaves commentsEnabled out (on by default)', 'blogComment', baseComment(), null],
    ['blogComment: on a post with commentsEnabled true', 'blogComment', { ...baseComment(), postCommentsEnabled: true }, null],
    ['blogComment: on a post with commentsEnabled false', 'blogComment', { ...baseComment(), postCommentsEnabled: false }, 'commentsOpen'],
    // Blog v7 (5.0.0-beta.2): a live post carries a title and a body (`hasBody`); an author's
    // delete is a tombstone (`tombstoneIsBlank`), which `hasBody` admits; `publishedAt` may run
    // at most 10 minutes past `$updatedAt` (`publishedNotAhead`), so a backdated import is fine.
    ['blogPost: a live post with comments on', 'blogPost', { ...baseBlogPost(), commentsEnabled: true }, null],
    ['blogPost: a live post with no title', 'blogPost', drop(baseBlogPost(), 'title'), 'hasBody'],
    ['blogPost: a tombstone (deleted, comments off, nothing else)', 'blogPost', blogTombstone({ publishedAt: BLOG_NOW }), null, { replace: true }],
    ['blogPost: a tombstone keeping its title', 'blogPost', blogTombstone({ title: 'still here' }), 'tombstoneIsBlank', { replace: true }],
    ['blogPost: a tombstone leaving comments on', 'blogPost', blogTombstone({ commentsEnabled: true }), 'tombstoneIsBlank', { replace: true }],
    ['blogPost: a tombstone with commentsEnabled left out', 'blogPost', drop(blogTombstone(), 'commentsEnabled'), 'tombstoneIsBlank', { replace: true }],
    ['blogPost: `deleted: false` on a live post', 'blogPost', { ...baseBlogPost(), commentsEnabled: true, deleted: false }, 'tombstoneIsBlank'],
    ['blogPost: publishedAt now', 'blogPost', { ...baseBlogPost(), publishedAt: BLOG_NOW }, null],
    ['blogPost: publishedAt backdated (an import)', 'blogPost', { ...baseBlogPost(), publishedAt: 1e12 }, null],
    // A day ahead, so a long live run reaching b19 late still finds it ahead.
    ['blogPost: publishedAt a day ahead', 'blogPost', { ...baseBlogPost(), publishedAt: BLOG_NOW + 86_400_000 }, 'publishedNotAhead'],
  ],
};

// Social v11 (5.0.0-beta.1, design M) keeps every v10 rule and adds `tombstoneIsBlank` to post and
// reply: an author's tombstone sets `deleted` (exactly true) and leaves out every content field;
// `notEmpty` admits it. Its cases are v10's plus the tombstones, run against its own file.
DECLARED_RULES['yappr-social-contract-v11.json'] = {
  ...DECLARED_RULES['yappr-social-contract-v10.json'],
  post: [...DECLARED_RULES['yappr-social-contract-v10.json'].post, 'tombstoneIsBlank'],
  reply: [...DECLARED_RULES['yappr-social-contract-v10.json'].reply, 'tombstoneIsBlank'],
};
CONSTRAINT_CASES['yappr-social-contract-v11.json'] = [
  ...CONSTRAINT_CASES['yappr-social-contract-v10.json'],
  ['post: a tombstone (deleted, nothing else)', 'post', { deleted: true }, null],
  ['post: a tombstone keeping its hashtag', 'post', { deleted: true, hashtag: 'kept' }, null],
  ['post: a tombstone keeping its text', 'post', { deleted: true, content: 'still here' }, 'tombstoneIsBlank'],
  ['post: a tombstone keeping its media', 'post', { deleted: true, ...media('https://example.com/a.png') }, 'tombstoneIsBlank'],
  ['post: a tombstone keeping its quote', 'post', { deleted: true, quotedPostId: id(), quotedPostOwnerId: id() }, 'tombstoneIsBlank'],
  ['post: a tombstone keeping its mention', 'post', { deleted: true, mentionedUserId: id() }, 'tombstoneIsBlank'],
  ['post: `deleted: false` alone', 'post', { deleted: false }, 'tombstoneIsBlank'],
  ['reply: a tombstone (deleted, the linkage kept)', 'reply', { deleted: true, rootPostId: id(), parentOwnerId: id() }, null],
  ['reply: a tombstone keeping its text', 'reply', { ...baseReply(), deleted: true }, 'tombstoneIsBlank'],
];

// Social v12 (5.0.0-beta.2) declares exactly v11's rules: its changes are the like counter indexes
// and `retractedWhen` on post and reply, neither of which is a propertyConstraints rule. A barred
// author's tombstone is still judged by `tombstoneIsBlank` (retractedWhen only lets it past the
// bar), so v11's cases are v12's, run against v12's own file.
DECLARED_RULES['yappr-social-contract-v12.json'] = DECLARED_RULES['yappr-social-contract-v11.json'];
CONSTRAINT_CASES['yappr-social-contract-v12.json'] = CONSTRAINT_CASES['yappr-social-contract-v11.json'];

// Social v13 (the mainnet candidate) renames every rule (names appear only in errors), and adds:
// `media` (mediaUrls, mediaDigests at 40 B per item and mediaKinds at 1 B per item agree in
// length), `live` (a post carries `live: true` unless it is a tombstone, and a tombstone does not),
// `parentIsRoot` (a top-level reply's parentOwnerId is its rootOwnerId, which the rootPostId
// reference binds to the post's owner: no forged "replied to you"), and on report `oneTarget`
// over three targets (post, reply, or a profile: `about`) and `boxOnContent` (the moderators' key
// box only on a post or reply report). The `where` bindings are judged by `--probes`.
DECLARED_RULES['yappr-social-contract-v13.json'] = {
  post: ['blankTombstone', 'embed', 'live', 'media', 'notEmpty', 'oneQuote', 'private', 'privateNoMedia', 'quoteOwner'],
  reply: ['blankTombstone', 'media', 'parentIsRoot', 'private', 'privateNoMedia'],
  report: ['boxOnContent', 'oneTarget', 'otherNote', 'resolvedStatus'],
};
/** A v13 post is `live` unless tombstoned. */
const v13Post = () => ({ content: 'constraint probe', live: true });
/** A v13 top-level reply: its parent is the root post, so its parentOwnerId is the root's owner. */
const v13Reply = () => {
  const rootOwner = id();
  return { content: 'constraint probe', rootPostId: id(), rootOwnerId: rootOwner, parentOwnerId: Uint8Array.from(rootOwner) };
};
/** `n` media items: a URL, a 40-byte digest (sha256 + fingerprint) and a kind byte each. */
const v13Media = (n, { urls = n, digests = n, kinds = n } = {}) => ({
  mediaUrls: Array.from({ length: urls }, (_, i) => `ipfs://bafyprobe${i}`),
  mediaDigests: bytes(40 * digests),
  mediaKinds: new Uint8Array(kinds),
});
const withoutEmpty = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value.length !== 0));
CONSTRAINT_CASES['yappr-social-contract-v13.json'] = [
  ['post: a public post', 'post', v13Post(), null],
  ['post: no live marker on a post that is not a tombstone', 'post', drop(v13Post(), 'live'), 'live'],
  ['post: a private post', 'post', { ...v13Post(), content: '🔒', ...privateFields() }, null],
  ['post: ciphertext without its nonce', 'post', { ...v13Post(), ...drop(privateFields(), 'nonce') }, 'private'],
  ['post: a private post carrying media', 'post', { ...v13Post(), ...privateFields(), ...v13Media(1) }, 'privateNoMedia'],
  ['post: an embed missing its doc type', 'post', { ...v13Post(), ...drop(embed(), 'embedDocType') }, 'embed'],
  ['post: a quote naming no owner', 'post', { ...v13Post(), quotedPostId: id() }, 'quoteOwner'],
  ['post: quoting a post AND a reply', 'post', { ...v13Post(), quotedPostId: id(), quotedReplyId: id(), quotedPostOwnerId: id() }, 'oneQuote'],
  ['post: a bare repost', 'post', { live: true, quotedPostId: id(), quotedPostOwnerId: id() }, null],
  ['post: nothing but the live marker', 'post', { live: true }, 'notEmpty'],
  ['post: one image, no text', 'post', { live: true, ...v13Media(1) }, null],
  ['post: four images with text', 'post', { ...v13Post(), ...v13Media(4) }, null],
  ['post: two URLs, one digest', 'post', { ...v13Post(), ...v13Media(2, { digests: 1 }) }, 'media'],
  ['post: two URLs and digests, one kind', 'post', { ...v13Post(), ...v13Media(2, { kinds: 1 }) }, 'media'],
  ['post: URLs with no digests or kinds', 'post', { ...v13Post(), ...withoutEmpty(v13Media(1, { digests: 0, kinds: 0 })) }, 'media'],
  ['post: digests and kinds with no URL', 'post', { ...v13Post(), ...withoutEmpty(v13Media(1, { urls: 0 })) }, 'media'],
  ['post: a tombstone (deleted, live gone)', 'post', { deleted: true }, null],
  ['post: a tombstone keeping its hashtag', 'post', { deleted: true, hashtag: 'kept' }, null],
  ['post: a tombstone still live', 'post', { deleted: true, live: true }, 'live'],
  ['post: a tombstone keeping its media', 'post', { deleted: true, ...v13Media(1) }, 'blankTombstone'],
  ['post: a tombstone keeping only its media digests', 'post', { deleted: true, mediaDigests: bytes(40) }, 'blankTombstone'],
  ['post: a tombstone keeping its text', 'post', { deleted: true, content: 'still here' }, 'blankTombstone'],
  ['post: a tombstone keeping its quote', 'post', { deleted: true, quotedPostId: id(), quotedPostOwnerId: id() }, 'blankTombstone'],
  ['post: `deleted: false` on a live post', 'post', { ...v13Post(), deleted: false }, 'blankTombstone'],
  ['reply: a top-level reply to the root post\'s owner', 'reply', v13Reply(), null],
  ['reply: forged, a top-level reply naming a parentOwnerId other than the root\'s owner', 'reply', { ...v13Reply(), parentOwnerId: id() }, 'parentIsRoot'],
  ['reply: a nested reply to another author in the thread', 'reply', { ...v13Reply(), replyToReplyId: id(), parentOwnerId: id() }, null],
  ['reply: a private reply', 'reply', { ...v13Reply(), content: '🔒', ...privateFields() }, null],
  ['reply: a nonce alone', 'reply', { ...v13Reply(), nonce: bytes(24) }, 'private'],
  ['reply: a private reply carrying media', 'reply', { ...v13Reply(), ...privateFields(), ...v13Media(1) }, 'privateNoMedia'],
  ['reply: two images', 'reply', { ...v13Reply(), ...v13Media(2) }, null],
  ['reply: three URLs, two digests', 'reply', { ...v13Reply(), ...v13Media(3, { digests: 2 }) }, 'media'],
  ['reply: a tombstone (deleted, the linkage kept)', 'reply', { ...drop(v13Reply(), 'content'), deleted: true }, null],
  ['reply: a tombstone keeping its media', 'reply', { ...drop(v13Reply(), 'content'), deleted: true, ...v13Media(1) }, 'blankTombstone'],
  ['reply: a tombstone keeping its text', 'reply', { ...v13Reply(), deleted: true }, 'blankTombstone'],
  ['report: a post report', 'report', baseReport(), null],
  ['report: a reply report', 'report', { ...drop(baseReport(), 'postId'), replyId: id() }, null],
  ['report: a profile report (about 1)', 'report', { ...drop(baseReport(), 'postId'), about: 1 }, null],
  ['report: naming a post AND a reply', 'report', { ...baseReport(), replyId: id() }, 'oneTarget'],
  ['report: naming a post AND the profile', 'report', { ...baseReport(), about: 1 }, 'oneTarget'],
  ['report: naming a reply AND the profile', 'report', { ...drop(baseReport(), 'postId'), replyId: id(), about: 1 }, 'oneTarget'],
  ['report: naming no target', 'report', drop(baseReport(), 'postId'), 'oneTarget'],
  ['report: a private post report carrying the moderators\' key box', 'report', { ...baseReport(), box: bytes(400) }, null],
  ['report: a private reply report carrying the box', 'report', { ...drop(baseReport(), 'postId'), replyId: id(), box: bytes(400) }, null],
  ['report: a profile report carrying a box', 'report', { ...drop(baseReport(), 'postId'), about: 1, box: bytes(400) }, 'boxOnContent'],
  ['report: "something else" saying what', 'report', { ...baseReport(), reason: 8, note: 'constraint probe' }, null],
  ['report: "something else" with no note', 'report', { ...baseReport(), reason: 8 }, 'otherNote'],
  ['report: sexual content involving minors (reason 9), no note needed', 'report', { ...baseReport(), reason: 9 }, null],
  ['report: handled with a status and a resolution', 'report', { ...baseReport(), status: 2, resolution: 'post removed' }, null, { replace: true }],
  ['report: a resolution with no status', 'report', { ...baseReport(), resolution: 'looked at it' }, 'resolvedStatus', { replace: true }],
];

// Social v14 (5.0.0-beta.3) keeps v13's rule names and behaviour, rewritten with `countPresent`
// (S2-S5 in docs/SOCIAL_V14.md): `private` and `embed` are "0 or all 3 present", `blankTombstone`
// is "none of the content paths present", `live` is "exactly one of deleted and live", `notEmpty`
// is "text, or at least one of six paths", and report `oneTarget` is "exactly one of postId,
// replyId and about". A reply no longer stores `parentOwnerId`/`rootOwnerId` (S7: its
// notification windows derive the owners), so `parentIsRoot` is gone. The cases below walk every
// countPresent boundary: each count a rule accepts, and the counts on either side of it.
DECLARED_RULES['yappr-social-contract-v14.json'] = {
  ...DECLARED_RULES['yappr-social-contract-v13.json'],
  reply: DECLARED_RULES['yappr-social-contract-v13.json'].reply.filter((rule) => rule !== 'parentIsRoot'),
};
/** A v14 reply: its thread root alone; the owners are read off the referenced documents. */
const v14Reply = () => ({ content: 'constraint probe', rootPostId: id() });
/** Every subset of `fields` of exactly `n` entries. */
const subsetsOf = (fields, n) => (n === 0 ? [{}] : Object.keys(fields).flatMap((key, i) =>
  subsetsOf(Object.fromEntries(Object.entries(fields).slice(i + 1)), n - 1).map((rest) => ({ [key]: fields[key], ...rest }))));
/** Cases for an all-or-none rule: 0 and all present are accepted, every partial subset breaks `rule`. */
const allOrNoneCases = (docType, base, rule, fields) => Object.keys(fields).flatMap((_, k, keys) => {
  const n = keys.length - k; // n = all, all - 1, … 1
  return subsetsOf(fields, n).map((subset) => [
    `${docType}: ${rule} with ${n} of ${keys.length} (${Object.keys(subset).join(', ')})`, docType, { ...base, ...subset }, n === keys.length ? null : rule,
  ]);
});
/** Post content paths a tombstone must leave out, one value each. */
const v14PostTombstoneFields = () => ({
  content: 'still here', ...v13Media(1), sensitive: true, ...privateFields(), ...embed(),
  mentionedUserId: id(), quotedPostId: id(), quotedReplyId: id(), quotedPostOwnerId: id(),
});
const v14ReplyTombstoneFields = () => ({ content: 'still here', ...v13Media(1), sensitive: true, ...privateFields(), mentionedUserId: id() });
CONSTRAINT_CASES['yappr-social-contract-v14.json'] = [
  // Every v13 post and report case still holds (same names, same behaviour).
  ...CONSTRAINT_CASES['yappr-social-contract-v13.json'].filter(([, docType]) => docType !== 'reply'),
  // private / embed: countPresent in [0, 3].
  ...allOrNoneCases('post', v13Post(), 'private', privateFields()),
  ...allOrNoneCases('post', v13Post(), 'embed', embed()),
  ...allOrNoneCases('reply', v14Reply(), 'private', privateFields()),
  ['post: no encryption field at all (countPresent 0)', 'post', v13Post(), null],
  // live: exactly one of deleted and live.
  ['post: live and not deleted (1 of 2)', 'post', v13Post(), null],
  ['post: a tombstone without live (1 of 2)', 'post', { deleted: true }, null],
  ['post: neither deleted nor live (0 of 2)', 'post', { content: 'constraint probe' }, 'live'],
  ['post: deleted and live (2 of 2)', 'post', { deleted: true, live: true }, 'live'],
  // notEmpty: text, or at least one of encryptedContent, mediaUrls, embedId, quotedPostId,
  // quotedReplyId, deleted (each alone is enough; a quote needs its owner for quoteOwner).
  ['post: notEmpty met by text alone', 'post', v13Post(), null],
  ['post: notEmpty met by ciphertext alone (no teaser)', 'post', { live: true, ...privateFields() }, null],
  ['post: notEmpty met by media alone', 'post', { live: true, ...v13Media(1) }, null],
  ['post: notEmpty met by an embed alone', 'post', { live: true, ...embed() }, null],
  ['post: notEmpty met by a quoted post alone', 'post', { live: true, quotedPostId: id(), quotedPostOwnerId: id() }, null],
  ['post: notEmpty met by a quoted reply alone', 'post', { live: true, quotedReplyId: id(), quotedPostOwnerId: id() }, null],
  ['post: notEmpty met by deleted alone (a tombstone)', 'post', { deleted: true }, null],
  ['post: notEmpty with an empty text and none of the six (countPresent 0)', 'post', { live: true, content: '' }, 'notEmpty'],
  ['post: notEmpty with only a hashtag, the sensitive flag and a mention', 'post', { live: true, hashtag: 'dash', sensitive: true, mentionedUserId: id() }, 'notEmpty'],
  // blankTombstone: a tombstone holds none of its content paths (countPresent = 0); each one alone breaks it.
  ['post: a blank tombstone keeping only its hashtag', 'post', { deleted: true, hashtag: 'kept' }, null],
  ...Object.entries(v14PostTombstoneFields()).map(([path, value]) => [`post: a tombstone keeping ${path} (countPresent 1)`, 'post', { deleted: true, [path]: value }, 'blankTombstone']),
  ['post: a tombstone keeping every content path (countPresent 15)', 'post', { deleted: true, ...v14PostTombstoneFields() }, 'blankTombstone'],
  // Replies: no stored owners.
  ['reply: a top-level reply (its root alone)', 'reply', v14Reply(), null],
  ['reply: a nested reply', 'reply', { ...v14Reply(), replyToReplyId: id() }, null],
  ['reply: a private reply carrying media', 'reply', { ...v14Reply(), ...privateFields(), ...v13Media(1) }, 'privateNoMedia'],
  ['reply: two images', 'reply', { ...v14Reply(), ...v13Media(2) }, null],
  ['reply: three URLs, two digests', 'reply', { ...v14Reply(), ...v13Media(3, { digests: 2 }) }, 'media'],
  ['reply: a blank tombstone (the linkage kept)', 'reply', { ...drop(v14Reply(), 'content'), deleted: true }, null],
  ['reply: a nested blank tombstone', 'reply', { ...drop(v14Reply(), 'content'), replyToReplyId: id(), deleted: true }, null],
  ...Object.entries(v14ReplyTombstoneFields()).map(([path, value]) => [`reply: a tombstone keeping ${path} (countPresent 1)`, 'reply', { ...drop(v14Reply(), 'content'), deleted: true, [path]: value }, 'blankTombstone']),
  // report oneTarget: exactly one of postId, replyId, about.
  ['report: oneTarget with all three targets (countPresent 3)', 'report', { ...baseReport(), replyId: id(), about: 1 }, 'oneTarget'],
];

/**
 * The `deleteConstraints` rules a contract declares (5.0.0-beta.3), keyed like
 * {@link DECLARED_RULES}: rules the STORED document must meet for its owner to
 * delete it, refused with 40147 `DocumentDeleteConstraintViolatedError` (paid).
 * Moderator deletes and ttl expiry are not judged.
 */
export const DECLARED_DELETE_RULES = {
  // S6: a report can be withdrawn only while no moderator has resolved it (`status` absent).
  'yappr-social-contract-v14.json': { report: ['pending'] },
};

/**
 * [label, docType, the stored document's data, the delete rule its owner's
 * delete breaks or null] — judged offline by `runConstraintCases` and
 * broadcast by verify-v10 r1wa (a resolved report's withdrawal is 40147).
 */
export const DELETE_CASES = {
  'yappr-social-contract-v14.json': [
    ['report: withdrawing an open report (no status)', 'report', baseReport(), null],
    ['report: withdrawing an open profile report', 'report', { ...drop(baseReport(), 'postId'), about: 1 }, null],
    ...[1, 2, 3].map((status) => [`report: withdrawing a report resolved with status ${status}`, 'report', { ...baseReport(), status }, 'pending']),
    ['report: withdrawing a resolved report that carries a resolution', 'report', { ...baseReport(), status: 2, resolution: 'post removed' }, 'pending'],
  ],
};

/**
 * The 40147 refusal of an owner's delete breaking the `deleteConstraints` rule
 * `rule`: Drive's DocumentDeleteConstraintViolatedError Display, naming the
 * rule ('… can not be deleted: it breaks its deleteConstraints rule "<rule>": …').
 */
export const deleteConstraintViolation = (rule) =>
  new RegExp(`breaks its deleteConstraints rule \\\\?"${rule}\\\\?":`, 'i');

/**
 * The rejection a live write breaking `rule` must produce: the node's 10422
 * `DocumentPropertyConstraintViolatedError` message naming exactly this rule
 * (quoted and followed by its `:` reason, so a rule whose name is a prefix of
 * another, or a different rule's 10422, cannot pass). The prose is that error's
 * Display and no other error produces it. The number itself is not required:
 * on beta.5 the broadcast refusal reached the SDK with `code: -1` and the
 * prose only. From beta.6 (platform#5112) `describeErr` also carries
 * `code=10422`; the rule's name in the prose is still what scores the case.
 */
export const constraintViolation = (rule) =>
  new RegExp(`breaks its propertyConstraints rule \\\\?"${rule}\\\\?":`, 'i');

/** The refused REPLACE-only cases of one contract and doctype (a tombstone, a moderator's edit), as [label, data, rule]. */
export function refusedReplaces(file, docType) {
  return CONSTRAINT_CASES[file]
    .filter(([, type, , rule, options]) => type === docType && rule !== null && options?.replace)
    .map(([label, , data, rule]) => [label, data, rule]);
}

/** The refused CREATE cases of one contract and doctype, as [label, data, rule]. */
export function refusedCreates(file, docType) {
  return CONSTRAINT_CASES[file]
    .filter(([, type, , rule, options]) => type === docType && rule !== null && !options?.replace && !options?.offlineOnly)
    .map(([label, , data, rule]) => [label, data, rule]);
}

// ---- Offline oracle ------------------------------------------------------------

/**
 * Runs every case through the `propertyConstraints` check consensus runs on a
 * create or replace, offline: from 4.2.0-beta.6 (platform#5051) the wasm-sdk's
 * `DataContract.checkDocumentPropertyConstraints` evaluates a document's rules
 * with rs-dpp's own code, so no extra package is needed. It judges the rules
 * alone (not the JSON schema). System times are the case's own (`options.at`,
 * default CASE_NOW): the pollr rules read `$createdAt` and `$updatedAt`; no
 * rule reads a height or a total.
 *
 * Returns the number of cases whose outcome is not the recorded one.
 */
export async function runConstraintCases({ loadContractSource, parseContract, platformVersion, Document }) {
  const owner = id();
  let failures = 0;
  console.log('\npropertyConstraints cases (DataContract.checkDocumentPropertyConstraints, the rules a create or replace runs):');
  for (const [file, cases] of Object.entries(CONSTRAINT_CASES)) {
    const source = loadContractSource(`contracts/${file}`);
    // The rule names the live batteries pin must be exactly the ones the file declares.
    for (const [docType, rules] of Object.entries(DECLARED_RULES[file] ?? {})) {
      const declared = Object.keys(source.documentSchemas[docType]?.propertyConstraints ?? {}).sort();
      if (JSON.stringify(declared) !== JSON.stringify([...rules].sort())) {
        failures += 1;
        console.log(`FAIL  ${file.replace(/\.json$/, '')}: ${docType} declares rules ${declared.join(', ')}, DECLARED_RULES says ${rules.join(', ')}`);
      }
    }
    const contract = parseContract(source, platformVersion);
    for (const [label, docType, data, rule, options] of cases) {
      const at = options?.at ?? {};
      let violation = null;
      try {
        const document = Document.fromObject({
          $formatVersion: '0', $id: id(), $ownerId: owner, $dataContractId: contract.id.toBytes(), $type: docType,
          $revision: at.revision ?? 1n, $createdAt: at.createdAt ?? CASE_NOW, $updatedAt: at.updatedAt ?? CASE_NOW, ...data,
        }, platformVersion);
        violation = contract.checkDocumentPropertyConstraints(document) ?? null;
      } catch (e) {
        violation = { rule: null, message: String(e?.message ?? e) };
      }
      const ok = rule === null ? violation === null : violation?.rule === rule;
      if (!ok) failures += 1;
      const outcome = violation === null ? 'accepted' : `10422 "${violation.rule}": ${String(violation.message).slice(0, 100)}`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.replace(/\.json$/, '')}: ${label} — ${outcome}${ok ? '' : ` (expected ${rule === null ? 'accepted' : `10422 on "${rule}"`})`}`);
    }
  }
  return failures + await runDeleteCases({ loadContractSource, parseContract, platformVersion, Document, owner });
}

/**
 * The `deleteConstraints` cases, offline. No package exposes a delete check,
 * but the rules are written in the `propertyConstraints` grammar and judged by
 * the same evaluator, so each file is parsed once more with every type's
 * `propertyConstraints` replaced by its `deleteConstraints`, and the STORED
 * document is judged with `checkDocumentPropertyConstraints`.
 */
async function runDeleteCases({ loadContractSource, parseContract, platformVersion, Document, owner }) {
  let failures = 0;
  console.log('\ndeleteConstraints cases (the stored document an owner\'s delete is judged on; 40147 when a rule breaks):');
  for (const [file, cases] of Object.entries(DELETE_CASES)) {
    const source = loadContractSource(`contracts/${file}`);
    for (const [docType, rules] of Object.entries(DECLARED_DELETE_RULES[file] ?? {})) {
      const declared = Object.keys(source.documentSchemas[docType]?.deleteConstraints ?? {}).sort();
      if (JSON.stringify(declared) !== JSON.stringify([...rules].sort())) {
        failures += 1;
        console.log(`FAIL  ${file.replace(/\.json$/, '')}: ${docType} declares delete rules ${declared.join(', ')}, DECLARED_DELETE_RULES says ${rules.join(', ')}`);
      }
    }
    const asWriteRules = structuredClone(source);
    for (const schema of Object.values(asWriteRules.documentSchemas)) {
      if (!schema.deleteConstraints) continue;
      schema.propertyConstraints = schema.deleteConstraints;
      delete schema.deleteConstraints;
    }
    const contract = parseContract(asWriteRules, platformVersion);
    for (const [label, docType, data, rule] of cases) {
      let violation = null;
      try {
        const document = Document.fromObject({
          $formatVersion: '0', $id: id(), $ownerId: owner, $dataContractId: contract.id.toBytes(), $type: docType,
          $revision: 1n, $createdAt: CASE_NOW, $updatedAt: CASE_NOW, ...data,
        }, platformVersion);
        violation = contract.checkDocumentPropertyConstraints(document) ?? null;
      } catch (e) {
        violation = { rule: null, message: String(e?.message ?? e) };
      }
      const ok = rule === null ? violation === null : violation?.rule === rule;
      if (!ok) failures += 1;
      const outcome = violation === null ? 'deletable' : `40147 "${violation.rule}": ${String(violation.message).slice(0, 100)}`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.replace(/\.json$/, '')}: ${label} — ${outcome}${ok ? '' : ` (expected ${rule === null ? 'deletable' : `40147 on "${rule}"`})`}`);
    }
  }
  return failures;
}
