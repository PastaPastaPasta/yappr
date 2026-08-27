/**
 * Verification battery for `refersTo` reference integrity (PLAN_REFERSTO.md §B2).
 *
 * `refersTo` makes consensus check that a referenced entity exists before a
 * document write is accepted. It needs protocol v14, so this runs on a devnet
 * (moutai by default) — testnet is still on v13 and would reject the contract.
 *
 * Two contracts are exercised:
 *   - the yappr social **v3-draft** (`scripts/register-social-v3-draft.mjs`):
 *     `follow.followingId` and `postMention.mentionedUserId` → `identity`;
 *   - a throwaway **scratch lab** contract registered by this script, whose
 *     doctypes exist only to probe `permanentDocument` references, null-unique
 *     index semantics and tombstone (`canBeDeleted: false`) mechanics.
 *
 * Cases (numbering follows PLAN_REFERSTO.md §B2):
 *   1  follow → nonexistent identity: rejected
 *   2  follow → real identity: accepted; the follow itself is still deletable
 *   3  postMention → nonexistent identity: rejected; → real identity: accepted
 *   4  scratch: ref → missing target rejected; target then ref accepted;
 *      deleting the target rejected; deleting the ref accepted
 *   5  replace path: changing `refId` to a missing id is rejected, while
 *      changing only a non-reference field is accepted
 *   6  error-shape capture — every rejection above is printed verbatim, plus two
 *      deliberately invalid contract registrations that surface the
 *      contract-time reference errors (deletable target / unknown document type)
 *   7  null-unique semantics: two optional identifier fields with unique
 *      `[field, $ownerId]` indexes, plain and with `nullSearchable: false`
 *   8  refersTo on an optional field: absent is fine, then set to a bad id
 *   9  tombstone mechanics: replace-to-clear works, delete is refused, and the
 *      replace fee is reported next to the create fee
 *
 * Every rejection is asserted by *reading back* after the failure, so the
 * DAPI 504 quirk (broadcast landed, the wait timed out) cannot be mistaken for
 * a consensus rejection.
 *
 * ## Environment
 *
 *   DEVNET_NAME           devnet name           (default: moutai)
 *   DAPI_ADDRESSES        comma-separated DAPI  (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *   DEVNET_IDENTITY_IDS   comma-separated devnet identity ids for the bot pool
 *                         (falls back to E2E_IDENTITY_IDS / .env.testing)
 *   E2E_SEED_PHRASE       the BIP39 seed the bot keys derive from
 *
 * Identity ids are not derivable (they come from the asset-lock outpoint), so
 * the devnet ids must be supplied; the *keys* are derived from `E2E_SEED_PHRASE`
 * at the same indexes, which means the devnet identities have to have been
 * provisioned from that same seed. If they were not, `--owner/--owner2` will
 * resolve but signing will fail.
 *
 * ## Run
 *
 *   node scripts/verify-refersto.mjs --dry-run
 *   node scripts/verify-refersto.mjs --contract <socialV3DraftId> \
 *        [--scratch <scratchContractId>] [--bot 0] [--bot2 1] \
 *        [--owner <idA>] [--owner2 <idB>] [--only 1,2,4] [--skip-negative-contracts]
 *
 * `--scratch` reuses a scratch contract from an earlier run; without it a fresh
 * one is registered by bot A (devnet is disposable, so that is the normal path).
 */
import {
  DataContract,
  Document,
  EvoSDK,
  IdentitySigner,
  PlatformVersion,
  ensureInitialized,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';

const SDK_TIMEOUT_MS = 30000;
const DEFAULT_DEVNET_NAME = 'moutai';
const DEFAULT_SEED_COUNT = 5;
/** Reads settle behind the write quorum; give the chain a beat before asserting. */
const SETTLE_MS = 3000;
/** How many settle intervals to wait before calling a write absent (~9s). */
const POLL_ATTEMPTS = 3;
/** Placeholder ids for `--dry-run`, where nothing is fetched or signed. */
const DRY_RUN_ID = '11111111111111111111111111111111';

// ---- Devnet SDK (inline on purpose: this script owns its network config) ----

/** `seed-1..5.<devnet>.networks.dash.org:1443` — the standard devnet seed layout. */
function defaultDevnetAddresses(devnetName) {
  return Array.from(
    { length: DEFAULT_SEED_COUNT },
    (_, i) => `https://seed-${i + 1}.${devnetName}.networks.dash.org:1443`
  );
}

/** Reads `DEVNET_NAME` / `DAPI_ADDRESSES` and builds a non-trusted devnet SDK. */
function devnetSdk() {
  const devnetName = process.env.DEVNET_NAME?.trim() || DEFAULT_DEVNET_NAME;
  const configured = (process.env.DAPI_ADDRESSES ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => (address.includes('://') ? address : `https://${address}`));
  const addresses = configured.length > 0 ? configured : defaultDevnetAddresses(devnetName);
  const sdk = new EvoSDK({
    network: 'devnet',
    devnetName,
    addresses,
    trusted: false,
    proofs: false,
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- The scratch lab contract ----------------------------------------------

/** A 32-byte identifier property, the only shape `refersTo` is allowed on. */
const identifierProperty = (position, description, refersTo) => ({
  type: 'array',
  byteArray: true,
  minItems: 32,
  maxItems: 32,
  contentMediaType: 'application/x.dash.dpp.identifier',
  position,
  description,
  ...(refersTo ? { refersTo } : {}),
});

const TARGET_REFERENCE = { type: 'permanentDocument', documentType: 'target' };

/**
 * Experiment 7's doctype (see `SCRATCH_DOCUMENT_SCHEMAS` below). `nullSearchable`
 * is the only difference between the two variants registered, so it is the only
 * knob here; omitted leaves it at the protocol default.
 */
function dualRefSchema({ nullSearchable, description }) {
  const uniqueIndex = (name, field) => ({
    name,
    unique: true,
    ...(nullSearchable === undefined ? {} : { nullSearchable }),
    properties: [{ [field]: 'asc' }, { $ownerId: 'asc' }],
  });
  return {
    type: 'object',
    properties: {
      a: identifierProperty(0, 'Optional identifier A'),
      b: identifierProperty(1, 'Optional identifier B'),
    },
    indices: [uniqueIndex('uniqueA', 'a'), uniqueIndex('uniqueB', 'b')],
    required: ['$createdAt'],
    additionalProperties: false,
    description,
  };
}

/**
 * Throwaway doctypes that exist only to probe protocol behaviour:
 *
 *   target        the `permanentDocument` anchor. `canBeDeleted: false` is a hard
 *                 requirement for a reference target, and it is mutable so
 *                 experiment 9 can tombstone-by-edit it.
 *   ref           required + optional references at `target` (cases 4, 5, 8).
 *   dualRef       experiment 7 — two optional identifier fields, each with its
 *                 own unique `[field, $ownerId]` index. This is the shape the v3
 *                 quote design needs (quotedPostId | quotedReplyId).
 *   dualRefStrict experiment 7 variant with `nullSearchable: false`.
 */
const SCRATCH_DOCUMENT_SCHEMAS = {
  target: {
    type: 'object',
    canBeDeleted: false,
    documentsMutable: true,
    properties: {
      content: { type: 'string', minLength: 0, maxLength: 256, position: 0, description: 'Tombstone-able payload' },
    },
    indices: [{ name: 'ownerAndTime', properties: [{ $ownerId: 'asc' }, { $createdAt: 'asc' }] }],
    required: ['$createdAt'],
    additionalProperties: false,
    description: 'Permanent reference target: can never be deleted, only edited',
  },
  ref: {
    type: 'object',
    documentsMutable: true,
    properties: {
      refId: identifierProperty(0, 'Required reference to a target document', TARGET_REFERENCE),
      optionalRefId: identifierProperty(1, 'Optional reference to a target document', TARGET_REFERENCE),
      note: { type: 'string', minLength: 0, maxLength: 64, position: 2, description: 'Non-reference field, for replace tests' },
    },
    indices: [{ name: 'ownerAndTime', properties: [{ $ownerId: 'asc' }, { $createdAt: 'asc' }] }],
    required: ['$createdAt', 'refId'],
    additionalProperties: false,
    description: 'Carries a required and an optional permanentDocument reference',
  },
  dualRef: dualRefSchema({
    description: 'Experiment 7: do two docs with a null `b` collide on uniqueB?',
  }),
  dualRefStrict: dualRefSchema({
    nullSearchable: false,
    description: 'Experiment 7 variant: the same, with nullSearchable: false',
  }),
};

/**
 * Contracts that must be refused at *registration* time, so the battery records
 * the contract-level reference errors as well as the document-level ones.
 * Both are structurally valid JSON schema — only consensus can reject them.
 */
const INVALID_CONTRACTS = {
  deletableTarget: {
    label: 'permanentDocument target whose documents can be deleted',
    expect: 'ReferencedDocumentTypeDeletableError (40122)',
    documentSchemas: {
      // No canBeDeleted:false — a reference target is not allowed to be deletable.
      target: {
        type: 'object',
        properties: { content: { type: 'string', minLength: 0, maxLength: 64, position: 0 } },
        required: ['$createdAt'],
        additionalProperties: false,
      },
      ref: {
        type: 'object',
        properties: { refId: identifierProperty(0, 'Reference to a deletable target', TARGET_REFERENCE) },
        required: ['$createdAt', 'refId'],
        additionalProperties: false,
      },
    },
  },
  unknownTarget: {
    label: 'permanentDocument target naming a document type that does not exist',
    expect: 'ReferencedDocumentTypeNotFoundError (40121)',
    documentSchemas: {
      ref: {
        type: 'object',
        properties: {
          refId: identifierProperty(0, 'Reference to a missing document type', {
            type: 'permanentDocument',
            documentType: 'noSuchDocumentType',
          }),
        },
        required: ['$createdAt', 'refId'],
        additionalProperties: false,
      },
    },
  },
};

// ---- Reporting --------------------------------------------------------------

let failures = 0;
/** Every rejection text seen, printed verbatim at the end for B3's matchers. */
const capturedErrors = [];

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function capture(label, message) {
  if (message) capturedErrors.push({ label, message });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const randomIdBytes = () => crypto.getRandomValues(new Uint8Array(32));

// ---- Document plumbing ------------------------------------------------------

/**
 * Builds a canonical document. `Document.fromObject` with raw-byte ids is the
 * only shape that survives wasm-sdk 4.1+: the `Document` constructor corrupts
 * Uint8Array properties there.
 */
function buildDocument({ contractId, docType, ownerId, data, entropy, revision = 1n, id }) {
  const idBytes = id ?? Document.generateId(docType, ownerId, contractId, entropy);
  const document = Document.fromObject(
    {
      $formatVersion: '0',
      $id: idBytes,
      $ownerId: bs58.decode(ownerId),
      $dataContractId: bs58.decode(contractId),
      $type: docType,
      $revision: revision,
      ...(entropy ? { $entropy: entropy } : {}),
      ...data,
    },
    PlatformVersion.current()
  );
  return { document, id: bs58.encode(idBytes) };
}

async function fetchDocument(sdk, contractId, docType, id) {
  try {
    return (await sdk.documents.get(contractId, docType, id)) ?? null;
  } catch {
    return null;
  }
}

const NOT_THROWN_BUT_ABSENT = 'the SDK reported no error, but the write is not on chain';

/**
 * Runs one write and decides its outcome by polling the chain until `accepted`
 * holds for the document, or the attempts run out. The chain — not the SDK's
 * throw/no-throw — is what decides whether a write was accepted here: the DAPI
 * gateway routinely 504s the wait for a transition that did land, and a facade
 * call that does not wait would report success for a transition consensus later
 * refuses. Reading back covers both; the SDK's error, when there was one, is
 * only reported as the reason for a write that never showed up.
 */
async function attemptWrite(sdk, { contractId, docType, id, accepted }, write) {
  let error = null;
  try {
    await write();
  } catch (e) {
    error = describeErr(e);
  }
  for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
    await settle();
    if (accepted(await fetchDocument(sdk, contractId, docType, id))) return { ok: true, id, error: null };
  }
  return { ok: false, id, error: error ?? NOT_THROWN_BUT_ABSENT };
}

/** Creates a document; acceptance is decided by reading it back. */
async function attemptCreate(sdk, who, { contractId, docType, data }) {
  const { document, id } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    entropy: randomIdBytes(),
  });
  return attemptWrite(sdk, { contractId, docType, id, accepted: (d) => d !== null }, () =>
    sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer })
  );
}

/** Replaces a document with a full data set at `revision + 1`. */
async function attemptReplace(sdk, who, { contractId, docType, id, data, revision }) {
  const nextRevision = revision + 1n;
  const { document } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    revision: nextRevision,
    id: bs58.decode(id),
  });
  const outcome = await attemptWrite(
    sdk,
    { contractId, docType, id, accepted: (d) => d?.revision !== undefined && d.revision >= nextRevision },
    () => sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer })
  );
  return { ...outcome, revision: outcome.ok ? nextRevision : revision };
}

/** Deletes a document; absence after the call is what counts as success. */
async function attemptDelete(sdk, who, { contractId, docType, id }) {
  return attemptWrite(sdk, { contractId, docType, id, accepted: (d) => d === null }, () =>
    sdk.documents.delete({
      document: { id, ownerId: who.ownerId, dataContractId: contractId, documentTypeName: docType },
      identityKey: who.identityKey,
      signer: who.signer,
    })
  );
}

function expectAccepted(label, outcome) {
  check(label, outcome.ok, outcome.ok ? `id=${outcome.id}` : `rejected: ${(outcome.error ?? '').slice(0, 200)}`);
  return outcome;
}

/**
 * The shapes a reference rejection can take, per the `#[error(...)]` formats in
 * rs-dpp's `errors/consensus/state/document/referenced_*_error.rs`. A rejection
 * whose text matches none of these is still a rejection — but not necessarily
 * the one the case is testing for, so it is called out rather than passed over.
 */
const REFERENCE_REJECTION = /referenced .*(not found|is disabled)|canBeDeleted|4012\d/i;

/**
 * Asserts Platform refused the write, and flags — without failing — a refusal
 * whose reason does not look like a reference rejection. A broken key, an
 * unfunded identity or a network fault would also produce "did not land", so a
 * bare PASS here is not by itself proof that refersTo enforcement fired; the
 * verbatim text printed at the end of the run is.
 */
function expectRejected(label, outcome, { expectReferenceReason = true } = {}) {
  const reason = outcome.error ?? '';
  check(label, !outcome.ok, outcome.ok ? 'ACCEPTED (BAD)' : reason.slice(0, 220));
  if (!outcome.ok) {
    capture(label, outcome.error);
    if (expectReferenceReason && !REFERENCE_REJECTION.test(reason)) {
      console.log(`NOTE  ${label} — rejected, but the reason does not read like a reference error; check the text below`);
    }
  }
  return outcome;
}

// ---- Identities -------------------------------------------------------------

/**
 * Devnet identity ids, which are not derivable and so must be configured. The
 * fallback reads `E2E_IDENTITY_IDS`, which holds **testnet** ids — those will
 * not resolve here, so the source is reported to make a forgotten
 * `DEVNET_IDENTITY_IDS` obvious rather than mysterious.
 */
function poolIdentityIds() {
  const raw = process.env.DEVNET_IDENTITY_IDS ?? '';
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length > 0) return { ids, source: 'DEVNET_IDENTITY_IDS' };
  return { ids: loadIdentityIds(), source: 'E2E_IDENTITY_IDS (testnet ids — set DEVNET_IDENTITY_IDS)' };
}

async function botSigner(sdk, index, explicitOwnerId) {
  let ownerId = explicitOwnerId;
  if (!ownerId) {
    const { ids, source } = poolIdentityIds();
    ownerId = ids[index];
    if (ownerId) console.log(`     (bot ${index} identity from ${source})`);
  }
  if (!ownerId) {
    throw new Error(
      `No identity id for bot index ${index}: pass --owner/--owner2 or set DEVNET_IDENTITY_IDS`
    );
  }
  const { wif } = criticalAuthKey(deriveIdentityKeys(index));
  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error(`Identity ${ownerId} not found on this devnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  if (!identityKey) throw new Error(`Identity ${ownerId} has no key ${CRITICAL_AUTH_KEY_ID}`);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wif);
  return { ownerId, identityKey, signer, label: `bot${index}(${ownerId})` };
}

// ---- Contract publishing ----------------------------------------------------

/** Assembles a contract from plain-object schemas. `fromJSON` is the only path that keeps a `tokens` block, and it is the one used here for consistency. */
function assembleContract({ ownerId, identityNonce, documentSchemas }) {
  return DataContract.fromJSON(
    {
      $formatVersion: '1',
      id: DataContract.generateId(ownerId, identityNonce).toBase58(),
      ownerId,
      version: 1,
      documentSchemas,
    },
    true,
    PlatformVersion.current()
  );
}

/**
 * Publishes a contract and reports the outcome without throwing.
 *
 * On error the contract is polled for, on the same terms as a document write: a
 * gateway timeout on a registration that actually landed must not be reported as
 * a consensus rejection, because the whole point of the negative cases is to
 * tell those two apart. `id` is derived locally from the nonce we read, so the
 * probe is best-effort — the authoritative id is the one `publish` returns, which
 * is why the success path reads it back off the published contract.
 */
async function publishContract(sdk, who, documentSchemas) {
  const identityNonce = ((await sdk.identities.nonce(who.ownerId)) ?? 0n) + 1n;
  const dataContract = assembleContract({ ownerId: who.ownerId, identityNonce, documentSchemas });
  const provisionalId = dataContract.id.toBase58();
  try {
    const published = await sdk.contracts.publish({
      dataContract,
      identityKey: who.identityKey,
      signer: who.signer,
    });
    return { ok: true, contractId: published.id.toBase58(), provisionalId, error: null };
  } catch (e) {
    const error = describeErr(e);
    for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
      await settle();
      let landed = null;
      try {
        landed = (await sdk.contracts.fetch(provisionalId)) ?? null;
      } catch { /* not there yet, or genuinely never will be */ }
      if (landed) return { ok: true, contractId: provisionalId, provisionalId, error: null };
    }
    return { ok: false, contractId: null, provisionalId, error };
  }
}

// ---- Cases ------------------------------------------------------------------

async function case1FollowMissingIdentity(ctx) {
  console.log('\n--- 1. follow → nonexistent identity ---');
  expectRejected(
    '1  follow to a nonexistent identity is rejected',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'follow',
      data: { followingId: randomIdBytes() },
    })
  );
}

async function case2FollowRealIdentity(ctx) {
  console.log('\n--- 2. follow → real identity, then unfollow ---');
  // `follow` has a unique [$ownerId, followingId] index, so a follow left behind
  // by an interrupted run would make 2a fail for the wrong reason. Clear it.
  await clearExistingFollow(ctx);

  const created = expectAccepted(
    '2a follow to a real identity is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'follow',
      data: { followingId: bs58.decode(ctx.botB.ownerId) },
    })
  );
  if (!created.ok) return;
  // The reference target is permanent; the referencing document is not.
  expectAccepted(
    '2b the follow itself is still deletable (unfollow works)',
    await attemptDelete(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'follow',
      id: created.id,
    })
  );
}

/** Deletes A→B follow documents left over from an earlier run, if any. */
async function clearExistingFollow(ctx) {
  let existing;
  try {
    existing = await ctx.sdk.documents.query({
      dataContractId: ctx.contractId,
      documentTypeName: 'follow',
      where: [['$ownerId', '==', ctx.botA.ownerId], ['followingId', '==', ctx.botB.ownerId]],
      limit: 1,
    });
  } catch (e) {
    console.log(`     (could not look for a stale follow: ${describeErr(e).slice(0, 120)})`);
    return;
  }
  const ids = existing instanceof Map ? [...existing.keys()] : Object.keys(existing ?? {});
  for (const id of ids) {
    const removed = await attemptDelete(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'follow',
      id,
    });
    console.log(`     (cleared a stale follow ${id}: ${removed.ok ? 'deleted' : 'FAILED'})`);
  }
}

async function case3PostMention(ctx) {
  console.log('\n--- 3. postMention → identity ---');
  // postMention.postId is deliberately NOT a reference: it is polymorphic
  // (post | reply), so a random id is fine and keeps the run idempotent.
  expectRejected(
    '3a postMention to a nonexistent identity is rejected',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'postMention',
      data: { postId: randomIdBytes(), mentionedUserId: randomIdBytes() },
    })
  );
  expectAccepted(
    '3b postMention to a real identity is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.contractId,
      docType: 'postMention',
      data: { postId: randomIdBytes(), mentionedUserId: bs58.decode(ctx.botB.ownerId) },
    })
  );
}

async function case4PermanentDocument(ctx) {
  console.log('\n--- 4. permanentDocument references on the scratch contract ---');
  expectRejected(
    '4a ref to a missing target is rejected',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'ref',
      data: { refId: randomIdBytes(), note: 'dangling' },
    })
  );

  const target = expectAccepted(
    '4b target created',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'target',
      data: { content: 'anchor' },
    })
  );
  if (!target.ok) return;
  ctx.targetId = target.id;

  const ref = expectAccepted(
    '4c ref to an existing target is accepted',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'ref',
      data: { refId: bs58.decode(target.id), note: 'anchored' },
    })
  );

  expectRejected(
    '4d deleting the target is rejected (canBeDeleted: false)',
    await attemptDelete(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'target',
      id: target.id,
    }),
    // A delete-immutability refusal, not a reference refusal.
    { expectReferenceReason: false }
  );

  if (ref.ok) {
    expectAccepted(
      '4e deleting the ref is accepted',
      await attemptDelete(ctx.sdk, ctx.botA, {
        contractId: ctx.scratchId,
        docType: 'ref',
        id: ref.id,
      })
    );
  }
}

async function case5ReplacePath(ctx) {
  console.log('\n--- 5. replace revalidates changed reference fields ---');
  const targetId = await ensureTarget(ctx);
  if (!targetId) {
    check('5  replace path', false, 'no target document available');
    return;
  }

  const ref = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.scratchId,
    docType: 'ref',
    data: { refId: bs58.decode(targetId), note: 'before' },
  });
  if (!expectAccepted('5a ref created for the replace tests', ref).ok) return;

  const noteOnly = expectAccepted(
    '5b replacing a non-reference field is accepted',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'ref',
      id: ref.id,
      revision: 1n,
      data: { refId: bs58.decode(targetId), note: 'after' },
    })
  );

  expectRejected(
    '5c replacing refId with a missing id is rejected',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'ref',
      id: ref.id,
      revision: noteOnly.ok ? noteOnly.revision : 1n,
      data: { refId: randomIdBytes(), note: 'after' },
    })
  );
}

async function case7NullUnique(ctx) {
  console.log('\n--- 7. null-unique semantics on two optional identifier fields ---');
  if (!ctx.hasDualRef) {
    // The scratch contract could not be registered with these doctypes: a unique
    // index over an optional property is itself refused. That is a finding, not
    // a script failure — the dual-field quote design is dead at contract level.
    check('7  the dualRef doctypes registered', false, 'the scratch contract was registered without them — see the rejection above');
    return;
  }
  for (const docType of ['dualRef', 'dualRefStrict']) {
    const label = docType === 'dualRef' ? 'plain unique index' : 'nullSearchable: false';
    const first = randomIdBytes();
    const second = randomIdBytes();

    const one = expectAccepted(
      `7  [${label}] first doc with only \`a\` set`,
      await attemptCreate(ctx.sdk, ctx.botA, { contractId: ctx.scratchId, docType, data: { a: first } })
    );
    if (!one.ok) continue;

    // THE QUESTION: both docs leave `b` null. If null entries share one slot in
    // the unique index, this second write collides and the dual-field quote
    // design (quotedPostId | quotedReplyId) is not viable in its plain form.
    const two = await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType,
      data: { a: second },
    });
    check(
      `7  [${label}] second doc with only \`a\` set — null \`b\` does NOT collide`,
      two.ok,
      two.ok ? `id=${two.id}` : (two.error ?? '').slice(0, 220)
    );
    if (!two.ok) capture(`7 [${label}] null-unique collision`, two.error);

    // Control: the unique index really is enforced for non-null values.
    expectRejected(
      `7  [${label}] control — a duplicate \`a\` for the same owner is rejected`,
      await attemptCreate(ctx.sdk, ctx.botA, { contractId: ctx.scratchId, docType, data: { a: first } }),
      // A unique-index violation, not a reference refusal.
      { expectReferenceReason: false }
    );
  }
}

async function case8OptionalReference(ctx) {
  console.log('\n--- 8. refersTo on an optional field ---');
  const targetId = await ensureTarget(ctx);
  if (!targetId) {
    check('8  optional reference', false, 'no target document available');
    return;
  }

  const ref = expectAccepted(
    '8a ref created with the optional reference absent',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'ref',
      data: { refId: bs58.decode(targetId), note: 'optional-absent' },
    })
  );
  if (!ref.ok) return;

  expectRejected(
    '8b replacing the optional reference with a missing id is rejected',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'ref',
      id: ref.id,
      revision: 1n,
      data: { refId: bs58.decode(targetId), optionalRefId: randomIdBytes(), note: 'optional-bad' },
    })
  );

  expectAccepted(
    '8c replacing the optional reference with a real target is accepted',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'ref',
      id: ref.id,
      revision: 1n,
      data: { refId: bs58.decode(targetId), optionalRefId: bs58.decode(targetId), note: 'optional-good' },
    })
  );
}

async function case9Tombstone(ctx) {
  console.log('\n--- 9. tombstone mechanics on a canBeDeleted:false doctype ---');
  const before = (await ctx.sdk.identities.balance(ctx.botA.ownerId)) ?? 0n;

  const target = expectAccepted(
    '9a target created',
    await attemptCreate(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'target',
      data: { content: 'x'.repeat(200) },
    })
  );
  if (!target.ok) return;
  await settle();
  const afterCreate = (await ctx.sdk.identities.balance(ctx.botA.ownerId)) ?? 0n;

  const cleared = expectAccepted(
    '9b replace-to-clear (tombstone by edit) is accepted',
    await attemptReplace(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'target',
      id: target.id,
      revision: 1n,
      data: { content: '' },
    })
  );
  await settle();
  const afterReplace = (await ctx.sdk.identities.balance(ctx.botA.ownerId)) ?? 0n;

  expectRejected(
    '9c deleting a canBeDeleted:false document is rejected',
    await attemptDelete(ctx.sdk, ctx.botA, {
      contractId: ctx.scratchId,
      docType: 'target',
      id: target.id,
    }),
    // A delete-immutability refusal, not a reference refusal.
    { expectReferenceReason: false }
  );

  const createCost = before - afterCreate;
  const replaceCost = afterCreate - afterReplace;
  console.log(`     create cost  : ${createCost} credits`);
  console.log(`     replace cost : ${replaceCost} credits${cleared.ok ? '' : ' (replace failed — treat as noise)'}`);
  if (createCost > 0n) {
    console.log(`     replace / create ratio: ${(Number(replaceCost) / Number(createCost)).toFixed(2)}`);
  }
}

/** Cases 5 and 8 need a `target`; case 4 normally supplies it. */
async function ensureTarget(ctx) {
  if (ctx.targetId) return ctx.targetId;
  const created = await attemptCreate(ctx.sdk, ctx.botA, {
    contractId: ctx.scratchId,
    docType: 'target',
    data: { content: 'anchor' },
  });
  if (!created.ok) return null;
  ctx.targetId = created.id;
  return created.id;
}

/**
 * Contract-registration rejections. Kept last: a refused contract create may or
 * may not consume the identity nonce, and nothing after this depends on it.
 */
async function case6InvalidContracts(ctx) {
  console.log('\n--- 6. contract-time reference errors ---');
  for (const [key, spec] of Object.entries(INVALID_CONTRACTS)) {
    const published = await publishContract(ctx.sdk, ctx.botA, spec.documentSchemas);
    check(
      `6  registering a contract with a ${spec.label} is rejected`,
      !published.ok,
      published.ok
        ? `ACCEPTED (BAD) as ${published.contractId}`
        : `${spec.expect}: ${(published.error ?? '').slice(0, 220)}`
    );
    capture(`6 ${key} (${spec.expect})`, published.error);
    await settle();
  }
}

const CASES = new Map([
  [1, case1FollowMissingIdentity],
  [2, case2FollowRealIdentity],
  [3, case3PostMention],
  [4, case4PermanentDocument],
  [5, case5ReplacePath],
  [7, case7NullUnique],
  [8, case8OptionalReference],
  [9, case9Tombstone],
  // Last on purpose: see case6InvalidContracts.
  [6, case6InvalidContracts],
]);

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    contract: null,
    scratch: null,
    botIndex: 0,
    bot2Index: 1,
    ownerId: null,
    owner2Id: null,
    only: null,
    skipNegativeContracts: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--scratch': args.scratch = argv[++i]; break;
      case '--bot': args.botIndex = Number(argv[++i]); break;
      case '--bot2': args.bot2Index = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--owner2': args.owner2Id = argv[++i]; break;
      case '--only': args.only = argv[++i]; break;
      case '--skip-negative-contracts': args.skipNegativeContracts = true; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dryRun && !args.contract) {
    throw new Error('--contract <socialV3DraftContractId> is required (or pass --dry-run)');
  }
  for (const [flag, value] of [['--bot', args.botIndex], ['--bot2', args.bot2Index]]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} takes a non-negative integer index`);
  }
  if (args.botIndex === args.bot2Index) {
    throw new Error('--bot and --bot2 must be different identities');
  }
  const known = [...CASES.keys()];
  if (args.only !== null) {
    args.only = args.only.split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n));
    if (args.only.length === 0) throw new Error('--only takes a comma-separated list of case numbers');
    const unknown = args.only.filter((n) => !known.includes(n));
    if (unknown.length > 0) throw new Error(`--only: unknown case number(s) ${unknown.join(', ')}`);
  }
  // Otherwise `--only 6 --skip-negative-contracts` would run nothing and then
  // congratulate itself with "ALL CHECKS PASSED".
  if (selectedCases(args).length === 0) {
    throw new Error('--only and --skip-negative-contracts together select no cases');
  }
  return args;
}

function selectedCases(args) {
  return [...CASES.keys()].filter((n) => {
    if (args.only && !args.only.includes(n)) return false;
    if (n === 6 && args.skipNegativeContracts) return false;
    return true;
  });
}

/**
 * `--dry-run`: no network, no keys. Proves the arguments parse, the scratch and
 * negative contracts assemble into valid DataContracts, and every document
 * shape the battery writes builds cleanly — so a live failure is Platform's
 * answer, not a bug in this script.
 */
function dryRun(args) {
  const contractId = args.contract ?? DRY_RUN_ID;
  const scratchId = args.scratch ?? DRY_RUN_ID;
  const ownerId = args.ownerId ?? DRY_RUN_ID;

  const scratch = assembleContract({ ownerId, identityNonce: 1n, documentSchemas: SCRATCH_DOCUMENT_SCHEMAS });
  const scratchJson = scratch.toJSON(PlatformVersion.current());
  console.log('scratch lab contract assembles:');
  for (const [name, schema] of Object.entries(scratchJson.documentSchemas)) {
    const refs = Object.entries(schema.properties ?? {})
      .filter(([, property]) => property.refersTo)
      .map(([property, { refersTo }]) => `${property}→${refersTo.type}(${refersTo.documentType ?? ''})`);
    console.log(
      `  ${name.padEnd(14)} canBeDeleted=${schema.canBeDeleted ?? true} mutable=${schema.documentsMutable ?? true}` +
      `${refs.length > 0 ? `  refs: ${refs.join(', ')}` : ''}`
    );
  }

  for (const [key, spec] of Object.entries(INVALID_CONTRACTS)) {
    assembleContract({ ownerId, identityNonce: 1n, documentSchemas: spec.documentSchemas });
    console.log(`negative contract "${key}" assembles locally (only consensus can reject it): expects ${spec.expect}`);
  }

  const shapes = [
    ['follow', contractId, { followingId: randomIdBytes() }],
    ['postMention', contractId, { postId: randomIdBytes(), mentionedUserId: randomIdBytes() }],
    ['target', scratchId, { content: 'anchor' }],
    ['ref', scratchId, { refId: randomIdBytes(), optionalRefId: randomIdBytes(), note: 'n' }],
    ['dualRef', scratchId, { a: randomIdBytes() }],
    ['dualRefStrict', scratchId, { a: randomIdBytes(), b: randomIdBytes() }],
  ];
  for (const [docType, onContract, data] of shapes) {
    const { id } = buildDocument({
      contractId: onContract,
      docType,
      ownerId,
      data,
      entropy: randomIdBytes(),
    });
    console.log(`document shape ok: ${docType.padEnd(14)} → ${id}`);
  }
  // Replaces reuse an existing id and carry no entropy.
  buildDocument({
    contractId: scratchId,
    docType: 'ref',
    ownerId,
    data: { refId: randomIdBytes(), note: 'replaced' },
    revision: 2n,
    id: bs58.decode(DRY_RUN_ID),
  });
  console.log('document shape ok: ref (replace, revision 2)');

  const { devnetName, addresses } = devnetSdk();
  console.log(`would run cases ${selectedCases(args).join(', ')} on devnet "${devnetName}" via ${addresses[0]} (+${addresses.length - 1} more)`);
  console.log('DRY RUN OK — no network calls were made');
}

// ---- Main -------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/verify-refersto.mjs --contract <id> [--scratch <id>] [--bot <n>] [--bot2 <n>]');
  console.error('       [--owner <id>] [--owner2 <id>] [--only 1,2,4] [--skip-negative-contracts] [--dry-run]');
  process.exit(1);
}

try {
  await ensureInitialized();

  if (args.dryRun) {
    dryRun(args);
    process.exit(0);
  }

  const { sdk, devnetName, addresses } = devnetSdk();
  await sdk.connect();
  const botA = await botSigner(sdk, args.botIndex, args.ownerId);
  const botB = await botSigner(sdk, args.bot2Index, args.owner2Id);
  console.log(`connected to devnet "${devnetName}" (${addresses.length} addresses)`);
  console.log(`social v3-draft contract: ${args.contract}`);
  console.log(`A=${botA.label}  B=${botB.label}`);

  let scratchId = args.scratch;
  // `--scratch` cannot tell us which doctypes that contract actually has;
  // assume the full set and let case 7 report what it finds.
  let hasDualRef = true;
  if (!scratchId) {
    console.log('registering the scratch lab contract …');
    const full = await publishContract(sdk, botA, SCRATCH_DOCUMENT_SCHEMAS);
    if (full.ok) {
      scratchId = full.contractId;
    } else {
      // Most likely cause: a unique index over an optional property (dualRef /
      // dualRefStrict) is refused outright. Record it, then fall back to the
      // reference-only doctypes so cases 1-6, 8 and 9 still run.
      console.log(`full scratch contract rejected: ${full.error}`);
      capture('7 scratch contract with the dualRef doctypes was rejected at registration', full.error);
      hasDualRef = false;
      await settle();
      const reduced = await publishContract(sdk, botA, {
        target: SCRATCH_DOCUMENT_SCHEMAS.target,
        ref: SCRATCH_DOCUMENT_SCHEMAS.ref,
      });
      if (!reduced.ok) throw new Error(`scratch lab contract could not be registered: ${reduced.error}`);
      scratchId = reduced.contractId;
    }
    await settle();
  }
  console.log(`scratch lab contract: ${scratchId}${hasDualRef ? '' : ' (without the dualRef doctypes)'}`);
  console.log('(reuse it on a rerun with --scratch)');

  const ctx = { sdk, contractId: args.contract, scratchId, botA, botB, targetId: null, hasDualRef };
  for (const number of selectedCases(args)) {
    await CASES.get(number)(ctx);
  }

  if (capturedErrors.length > 0) {
    console.log('\n--- 6. captured rejection texts (verbatim, for lib/error-utils.ts) ---');
    for (const { label, message } of capturedErrors) {
      console.log(`\n[${label}]\n${message}`);
    }
  }

  console.log('');
  console.log(`scratch lab contract: ${scratchId}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
