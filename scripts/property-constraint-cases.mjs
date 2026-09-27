/**
 * The 4.2.0-beta.5 `propertyConstraints` rules Yappr's contracts declare, and
 * the documents each must accept and refuse (DocumentPropertyConstraintViolated,
 * 10422). docs/CONTRACTS_BETA5.md explains every rule.
 *
 * One table, two consumers:
 *   - `validate-contract-offline.mjs --constraints` runs every case through
 *     rs-dpp's own document validation offline (`ExtendedDocument.validate`
 *     from @dashevo/wasm-dpp, which the node runs on a create or replace), so
 *     a rule that drifts from its cases fails before anything is registered;
 *   - the live batteries (verify-v9 c1, verify-storefront s20, verify-pollr
 *     p12, verify-blog b19) broadcast the refused create cases against the
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
  'yappr-social-contract-v9.json': {
    post: ['embedAllOrNone', 'oneQuoteTarget', 'privateAllOrNone', 'privateHasNoMedia', 'quoteNamesOwner', 'tombstoneIsBlank'],
    reply: ['privateAllOrNone', 'privateHasNoMedia', 'tombstoneIsBlank'],
  },
  'yappr-storefront-contract.json': {
    storeItem: ['pricedHasCurrency'],
    shippingZone: ['flatRateHasCurrency', 'tieredHasTiers'],
  },
  'pollr-contract.json': { poll: ['optionsContiguous'] },
  'yappr-blog-contract.json': { blogPost: ['chunksContiguous'] },
};

// ---- Base documents (valid under every rule) --------------------------------

export const basePost = () => ({ content: 'constraint probe', language: 'en' });
export const baseReply = () => ({ content: 'constraint probe', rootPostId: id(), parentOwnerId: id() });
const privateFields = () => ({ encryptedContent: bytes(48), epoch: 1, nonce: bytes(24) });
const embed = () => ({ embedContractId: id(), embedDocType: 'poll', embedId: id() });
export const baseItem = () => ({ storeId: id(), title: 'constraint probe', status: 'active' });
export const baseZone = () => ({ storeId: id(), name: 'constraint probe', rateType: 'flat' });
export const basePoll = () => ({ question: 'constraint probe?', option0: 'a', option1: 'b' });
export const baseBlogPost = () => ({ blogId: id(), title: 'constraint probe', slug: 'constraint-probe', data0: bytes(16) });

const drop = (fields, ...names) => Object.fromEntries(Object.entries(fields).filter(([key]) => !names.includes(key)));

/**
 * [label, docType, data, refusedBy] — `refusedBy` is the rule the document
 * breaks, or null when it must be accepted. `replace: true` marks a shape only
 * a replace writes (a tombstone); the offline oracle validates it the same way,
 * because the node runs the rules on a replace against the whole document.
 */
export const CONSTRAINT_CASES = {
  'yappr-social-contract-v9.json': [
    ['post: a public post', 'post', basePost(), null],
    ['post: a private post (all three encryption fields, teaser)', 'post', { ...basePost(), content: '🔒', ...privateFields() }, null],
    ['post: ciphertext without its nonce', 'post', { ...basePost(), ...drop(privateFields(), 'nonce') }, 'privateAllOrNone'],
    ['post: an epoch alone', 'post', { ...basePost(), epoch: 3 }, 'privateAllOrNone'],
    ['post: a private post carrying mediaUrl', 'post', { ...basePost(), ...privateFields(), mediaUrl: 'https://example.com/a.png' }, 'privateHasNoMedia'],
    ['post: a poll embed (all three fields)', 'post', { ...basePost(), ...embed() }, null],
    ['post: an embed missing its doc type', 'post', { ...basePost(), ...drop(embed(), 'embedDocType') }, 'embedAllOrNone'],
    ['post: a quote with its owner', 'post', { ...basePost(), quotedPostId: id(), quotedPostOwnerId: id() }, null],
    ['post: a reply quote with its owner', 'post', { ...basePost(), quotedReplyId: id(), quotedPostOwnerId: id() }, null],
    ['post: a quote naming no owner', 'post', { ...basePost(), quotedPostId: id() }, 'quoteNamesOwner'],
    ['post: quoting a post AND a reply', 'post', { ...basePost(), quotedPostId: id(), quotedReplyId: id(), quotedPostOwnerId: id() }, 'oneQuoteTarget'],
    ['post: a tombstone (blank, quote kept)', 'post', { ...basePost(), content: '', deleted: true, quotedPostId: id(), quotedPostOwnerId: id(), hashtag: 'kept' }, null, { replace: true }],
    ['post: a tombstone whose dead quote was cleared (owner kept)', 'post', { ...basePost(), content: '', deleted: true, quotedPostOwnerId: id() }, null, { replace: true }],
    ['post: a tombstone keeping its text', 'post', { ...basePost(), deleted: true }, 'tombstoneIsBlank', { replace: true }],
    ['post: a tombstone keeping its media', 'post', { ...basePost(), content: '', deleted: true, mediaUrl: 'https://example.com/a.png' }, 'tombstoneIsBlank', { replace: true }],
    ['post: a tombstone keeping its ciphertext', 'post', { ...basePost(), content: '', deleted: true, ...privateFields() }, 'tombstoneIsBlank', { replace: true }],
    ['post: `deleted: false` is not judged here (40128 refuses it on a replace)', 'post', { ...basePost(), deleted: false }, null],
    ['reply: a public reply', 'reply', baseReply(), null],
    ['reply: a private reply', 'reply', { ...baseReply(), content: '🔒', ...privateFields() }, null],
    ['reply: a nonce alone', 'reply', { ...baseReply(), nonce: bytes(24) }, 'privateAllOrNone'],
    ['reply: a private reply carrying mediaUrl', 'reply', { ...baseReply(), ...privateFields(), mediaUrl: 'ipfs://bafy' }, 'privateHasNoMedia'],
    ['reply: a tombstone', 'reply', { ...baseReply(), content: '', deleted: true }, null, { replace: true }],
    ['reply: a tombstone keeping its text', 'reply', { ...baseReply(), deleted: true }, 'tombstoneIsBlank', { replace: true }],
  ],
  'yappr-storefront-contract.json': [
    ['storeItem: priced with a currency', 'storeItem', { ...baseItem(), basePrice: 1000, currency: 'USD' }, null],
    ['storeItem: unpriced (no price, no variants)', 'storeItem', baseItem(), null],
    ['storeItem: variants with a currency', 'storeItem', { ...baseItem(), variants: '{"axes":[]}', currency: 'EUR' }, null],
    ['storeItem: a price with no currency', 'storeItem', { ...baseItem(), basePrice: 1000 }, 'pricedHasCurrency'],
    ['storeItem: variants with no currency', 'storeItem', { ...baseItem(), variants: '{"axes":[]}' }, 'pricedHasCurrency'],
    ['shippingZone: flat with rate and currency', 'shippingZone', { ...baseZone(), flatRate: 500, currency: 'USD' }, null],
    ['shippingZone: flat with no rate (free shipping)', 'shippingZone', baseZone(), null],
    ['shippingZone: flat carrying a pricing config in tiers', 'shippingZone', { ...baseZone(), flatRate: 0, currency: 'USD', tiers: '{"weightRate":10}' }, null],
    ['shippingZone: weight_tiered with tiers', 'shippingZone', { ...baseZone(), rateType: 'weight_tiered', tiers: '[]', currency: 'USD' }, null],
    ['shippingZone: a flat rate with no currency', 'shippingZone', { ...baseZone(), flatRate: 500 }, 'flatRateHasCurrency'],
    ['shippingZone: weight_tiered with no tiers', 'shippingZone', { ...baseZone(), rateType: 'weight_tiered' }, 'tieredHasTiers'],
    ['shippingZone: price_tiered with no tiers', 'shippingZone', { ...baseZone(), rateType: 'price_tiered', flatRate: 100, currency: 'USD' }, 'tieredHasTiers'],
  ],
  'pollr-contract.json': [
    ['poll: two options', 'poll', basePoll(), null],
    ['poll: ten options', 'poll', { ...basePoll(), ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`option${i + 2}`, `o${i + 2}`])) }, null],
    ['poll: option3 with no option2', 'poll', { ...basePoll(), option3: 'gap' }, 'optionsContiguous'],
    ['poll: option9 alone after option1', 'poll', { ...basePoll(), option9: 'gap' }, 'optionsContiguous'],
  ],
  'yappr-blog-contract.json': [
    ['blogPost: one chunk', 'blogPost', baseBlogPost(), null],
    ['blogPost: four chunks', 'blogPost', { ...baseBlogPost(), data1: bytes(8), data2: bytes(8), data3: bytes(8) }, null],
    ['blogPost: data2 with no data1', 'blogPost', { ...baseBlogPost(), data2: bytes(8) }, 'chunksContiguous'],
    ['blogPost: data3 with no data2', 'blogPost', { ...baseBlogPost(), data1: bytes(8), data3: bytes(8) }, 'chunksContiguous'],
  ],
};

/** The rejection a live write breaking `rule` must produce: the code, or the node's words naming the rule. */
export const constraintViolation = (rule) =>
  new RegExp(`\\bcode"?\\s*[=:]\\s*10422\\b|breaks its propertyConstraints rule "?${rule}"?`, 'i');

/** The refused CREATE cases of one contract and doctype, as [label, data, rule]. */
export function refusedCreates(file, docType) {
  return CONSTRAINT_CASES[file]
    .filter(([, type, , rule, options]) => type === docType && rule !== null && !options?.replace)
    .map(([label, , data, rule]) => [label, data, rule]);
}

// ---- Offline oracle ------------------------------------------------------------

/**
 * Runs every case through rs-dpp's document validation, offline. The wasm-sdk
 * the app ships has no document validator (it validates on broadcast), so this
 * uses @dashevo/wasm-dpp at the same version: `ExtendedDocument.validate` is
 * `DataContract::validate_document`, the check the node runs on a create or
 * replace, `propertyConstraints` included. wasm-dpp is not a dependency (the
 * app never loads it); without it the run is SKIPPED with a notice, as the ajv
 * meta-schema check is. Install it for a run with
 * `npm install --no-save <the @dashevo/wasm-dpp tarball of the pinned SDK>`.
 *
 * Returns the number of cases whose outcome is not the recorded one, or null
 * when skipped. The contract bytes come from the wasm-sdk parse, so the two
 * packages must be the same platform version.
 */
export async function runConstraintCases({ loadContractSource, parseContract, platformVersion }) {
  let wasmDpp;
  try {
    const { createRequire } = await import('node:module');
    const module = createRequire(import.meta.url)('@dashevo/wasm-dpp');
    wasmDpp = await (module.default ?? module)();
  } catch (e) {
    console.log(`\npropertyConstraints cases: SKIPPED (@dashevo/wasm-dpp unavailable: ${String(e?.message ?? e).slice(0, 80)})`);
    return null;
  }
  const protocolVersion = platformVersion.protocolVersion ?? platformVersion.version;
  const contracts = new wasmDpp.DataContractFactory(protocolVersion);
  const documents = new wasmDpp.DocumentFactory(protocolVersion, { generate: () => bytes(32) });
  const owner = new wasmDpp.Identifier(Buffer.from(id()));
  let failures = 0;
  console.log('\npropertyConstraints cases (rs-dpp document validation, the check a create or replace runs):');
  for (const [file, cases] of Object.entries(CONSTRAINT_CASES)) {
    const contract = await contracts.createFromBuffer(parseContract(loadContractSource(`contracts/${file}`)).toBytes(platformVersion), true);
    for (const [label, docType, data, rule] of cases) {
      // wasm-dpp reads byte properties from Buffers (a bare Uint8Array arrives as a map).
      const values = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value instanceof Uint8Array ? Buffer.from(value) : value]));
      let error = null;
      try {
        const result = documents.create(contract, owner, docType, values).validate(protocolVersion);
        error = result.isValid() ? null : result.getFirstError();
      } catch (e) {
        error = { message: String(e?.message ?? e) };
      }
      const code = error?.getCode?.();
      const message = String(error?.message ?? '');
      const ok = rule === null
        ? error === null
        : code === 10422 && message.includes(`rule "${rule}"`);
      if (!ok) failures += 1;
      const outcome = error === null ? 'accepted' : `${code} ${message.slice(0, 110)}`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.replace(/\.json$/, '')}: ${label} — ${outcome}${ok ? '' : ` (expected ${rule === null ? 'accepted' : `10422 on "${rule}"`})`}`);
    }
  }
  return failures;
}
