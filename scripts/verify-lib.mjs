/**
 * Shared infrastructure for the registration-day contract batteries.
 *
 * `scripts/verify-v7.mjs` is a thin file of v7 CASES on top of this module:
 * the devnet SDK with its quorum-rotation reconnect, the readback-decided
 * write helpers, the strict wrong-reason-fails rejection matchers, the
 * PASS/FAIL ledger and the CLI/dry-run/report shell all live here.
 *
 * Extracted from `scripts/verify-v5.mjs` — verbatim apart from the parts v7
 * has no analogue for, which were dropped rather than left as unreachable
 * residue (delete-by-id, the reference/foreign-delete matchers, the
 * bookmark/postMention shapes). `verify-v5.mjs` is deliberately NOT
 * refactored onto this module: it is the frozen record of the v5 cut, its
 * `--dry-run` only exercises shape building, and a rewrite of its live paths
 * could not be validated without re-running the whole battery against a v5
 * contract that no longer exists on chain.
 *
 * Nothing here is topology-specific. The `post`/`reply` data builders are NOT
 * here on purpose: their required properties changed between cuts (v7 removed
 * the attested `author`), so each battery declares its own.
 */
import {
  Document,
  EvoSDK,
  IdentitySigner,
  PlatformVersion,
  TokenPaymentInfo,
  ensureInitialized,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';
import { createdId, deriveDocumentIdBytes, findRecentByValues } from './seed/seed-lib.mjs';
const SDK_TIMEOUT_MS = 30000;
const DEFAULT_DEVNET_NAME = 'moutai';
const DEFAULT_SEED_COUNT = 5;
/** Reads settle behind the write quorum; give the chain a beat before asserting. */
const SETTLE_MS = 3000;
/** How many settle intervals to wait before calling a write absent (~9s). */
const POLL_ATTEMPTS = 3;
/** Placeholder ids for `--dry-run`, where nothing is fetched or signed. */
const DRY_RUN_ID = '11111111111111111111111111111111';
/** YAPP is at token position 0; a battery's writes cost 10/3/1 per document. */
const YAPP_TOKEN_POSITION = 0;
/** Below this the run cannot finish, so it aborts instead of failing cases. */
const MIN_YAPP_BALANCE = 150n;
// ---- Devnet SDK -------------------------------------------------------------

function defaultDevnetAddresses(devnetName) {
  return Array.from(
    { length: DEFAULT_SEED_COUNT },
    (_, i) => `https://seed-${i + 1}.${devnetName}.networks.dash.org:1443`
  );
}

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
    // trusted mode is mandatory: wasm-sdk panics on `proofs: false` and refuses
    // non-trusted proof verification; quorum keys are prefetched from
    // https://quorums.<devnetName>.networks.dash.org (or QUORUM_URL).
    trusted: true,
    ...(process.env.QUORUM_URL ? { quorumUrl: process.env.QUORUM_URL } : {}),
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- Resilient connection ---------------------------------------------------
//
// Long runs (~20 min) outlive devnet quorum rotations: the trusted context
// prefetches quorum keys at connect, a mid-run DKG makes newer proofs verify
// against a quorum it never learned ("invalid quorum: Quorum not found"), the
// failing proofs ban every DAPI address ("no available addresses …"), and the
// SDK instance is dead. There is no refresh API, so the cure is a FULL
// reconnect: build a fresh EvoSDK (fresh quorum prefetch + address pool),
// re-ratchet the protocol version, re-cache the contract, and swap it in. All
// battery code holds `sdkHandle` — a proxy that always forwards to the current
// instance — so a swap is transparent to in-flight helpers.

/** Errors that mean "this SDK instance is dead", not "this request was refused". */
const TRANSPORT_COLLAPSE = /no available addresses|invalid quorum|quorum not found/i;

let activeSdk = null;
let reconnectContractId = null;
let reconnectPromise = null;

const sdkHandle = new Proxy(
  {},
  {
    get(_, prop) {
      const value = activeSdk[prop];
      return typeof value === 'function' ? value.bind(activeSdk) : value;
    },
  }
);

/** Connect + protocol-version ratchet + contract cache: everything a fresh instance needs. */
async function buildConnectedSdk(contractId) {
  const { sdk, devnetName, addresses } = devnetSdk();
  await sdk.connect();
  // PROTOCOL-VERSION RATCHET (load-bearing): rs-sdk starts every devnet at
  // protocol version 12 and only ratchets upward from *verified* response
  // metadata (rs-sdk sdk.rs `min_protocol_version` + `maybe_update_protocol_version`).
  // Parsing the v5 contract needs the PV14+ ranked-index grammar, so any proved
  // query that touches it before the ratchet dies inside proof verification
  // with "dash drive: protocol: value wrong type error: unexpected property
  // name" — and the thrown verify never ratchets. One proved epoch query
  // teaches the SDK the chain's real version first.
  const epochInfo = await sdk.epoch.current();
  // Cache the contract so the trusted SDK can verify token-cost result proofs
  // ("unknown contract … in token verification" otherwise).
  await sdk.contracts.fetch(contractId);
  return { sdk, devnetName, addresses, protocolVersion: epochInfo?.toJSON?.()?.protocolVersion };
}

/** Replaces the dead instance behind `sdkHandle`; concurrent callers share one attempt. */
async function reconnectSdk(reason) {
  if (!reconnectPromise) {
    console.log(`     (transport collapsed — reconnecting: ${reason.slice(0, 120)})`);
    reconnectPromise = (async () => {
      const { sdk, protocolVersion } = await buildConnectedSdk(reconnectContractId);
      activeSdk = sdk;
      console.log(`     (reconnected, PV${protocolVersion})`);
    })().finally(() => {
      reconnectPromise = null;
    });
  }
  return reconnectPromise;
}

// ---- Reporting --------------------------------------------------------------

let failures = 0;
/** Every rejection text seen, printed verbatim at the end. */
const capturedErrors = [];
export function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function capture(label, message) {
  if (message) capturedErrors.push({ label, message });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
export const randomIdBytes = () => crypto.getRandomValues(new Uint8Array(32));

// ---- Document plumbing ------------------------------------------------------

/**
 * `Document.fromObject` with raw-byte ids is the only shape that survives
 * wasm-sdk 4.1+ (the `Document` constructor corrupts Uint8Array properties).
 *
 * Protocol 14: a create's id commits to the transition's identity contract
 * nonce, which `documents.create()` assigns internally — so a create built
 * here carries a PLACEHOLDER `$id` and `id` is `null`; the stored id is read
 * off the Document `create()` returns (`createdId`). Pass `nonce` to derive the
 * real id when the transition is built by hand, or `id` for a replace/delete.
 */
export function buildDocument({ contractId, docType, ownerId, data, entropy, revision = 1n, createdAt, id, nonce }) {
  const idBytes = id
    ?? (nonce !== undefined ? deriveDocumentIdBytes({ contractId, ownerId, docType, entropy, nonce }) : randomIdBytes());
  const document = Document.fromObject(
    {
      $formatVersion: '0',
      $id: idBytes,
      $ownerId: bs58.decode(ownerId),
      $dataContractId: bs58.decode(contractId),
      $type: docType,
      $revision: revision,
      ...(entropy ? { $entropy: entropy } : {}),
      ...(createdAt !== undefined ? { $createdAt: createdAt } : {}),
      ...data,
    },
    PlatformVersion.current()
  );
  return { document, id: (id || nonce !== undefined) ? bs58.encode(idBytes) : null };
}

const READ_ATTEMPTS = 4;

/** Retries transient read faults; only a successful read is an answer. */
export async function readback(fn) {
  let lastError;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (TRANSPORT_COLLAPSE.test(describeErr(e))) {
        // A failed reconnect (e.g. a second quorum rotation mid-rebuild) must
        // consume this attempt and back off, not abort the whole case.
        try {
          await reconnectSdk(describeErr(e));
          continue;
        } catch (reconnectError) {
          lastError = reconnectError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error(
    `read failed after ${READ_ATTEMPTS} attempts — cannot distinguish absence from unavailability: ${describeErr(lastError)}`
  );
}

export async function fetchDocument(sdk, contractId, docType, id) {
  return readback(async () => (await sdk.documents.get(contractId, docType, id)) ?? null);
}

/** Identifier values arrive as bytes or base58 depending on the surface. */
export function asBase58(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return bs58.encode(Uint8Array.from(value));
}

/**
 * "Does <owner>'s entry for this target exist?" — the indexOnly acceptance
 * read. Equality on the entry index's leading property plus the terminal
 * lowers onto the entry level's member keys.
 */
export async function entryExists(sdk, contractId, docType, keyField, keyValue, ownerId) {
  return readback(async () => {
    const result = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [
        [keyField, '==', keyValue],
        ['$ownerId', '==', ownerId],
      ],
    });
    return result.size > 0;
  });
}

/** Reads one countable index's total for a single key (0 when unmaterialized). */
export async function countBy(sdk, contractId, docType, field, value) {
  return readback(async () => {
    const raw = await sdk.documents.count({
      dataContractId: contractId,
      documentTypeName: docType,
      where: [[field, '==', value]],
    });
    const total = raw instanceof Map ? raw.get('') : raw?.[''];
    return total === undefined || total === null ? 0 : Number(total);
  });
}

const NOT_THROWN_BUT_ABSENT = 'the SDK reported no error, but the write is not on chain';

/**
 * Runs one write and decides its outcome by polling the chain until `accepted`
 * holds, or the attempts run out. The CHAIN — not the SDK's throw/no-throw —
 * decides: the DAPI gateway routinely 504s the wait for a transition that DID
 * land, and js documents.create() can throw post-broadcast for indexOnly types
 * even when the write landed. Readback covers both.
 */
async function attemptWrite({ accepted }, write) {
  let error = null;
  let result;
  try {
    result = await write();
  } catch (e) {
    error = describeErr(e);
    // A dead SDK instance is not a consensus verdict: reconnect and retry the
    // broadcast once. The retry reuses the same document and entropy; for a
    // stored type a first broadcast that DID land is then found by the value
    // readback below, for a unique-indexed one it surfaces as a duplicate.
    if (TRANSPORT_COLLAPSE.test(error)) {
      try {
        await reconnectSdk(error);
        result = await write();
        error = null;
      } catch (retryError) {
        // Keep whichever error the retry (or the reconnect itself) produced;
        // the readback polls below still decide the write's real fate.
        error = describeErr(retryError);
      }
    }
  }
  for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
    await settle();
    if (await accepted(result)) return { ok: true, error: null, result };
  }
  return { ok: false, error: error ?? NOT_THROWN_BUT_ABSENT };
}

/** The token-payment agreement a token-priced doctype's create must carry. */
function paymentInfo(tokenCost) {
  return tokenCost
    ? {
        tokenPaymentInfo: new TokenPaymentInfo({
          tokenContractPosition: YAPP_TOKEN_POSITION,
          maximumTokenCost: BigInt(tokenCost),
        }),
      }
    : {};
}

/**
 * Creates a STORED document; acceptance = it reads back by id. The id is the
 * one `create()` RETURNED (protocol 14 derives it from the nonce the SDK
 * picked); when the call threw after broadcasting, the owner's recent
 * documents are scanned for one carrying exactly these values instead.
 */
export async function attemptCreate(sdk, who, { contractId, docType, data, tokenCost }) {
  const { document } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    entropy: randomIdBytes(),
  });
  let id = null;
  // Bounded to THIS write: a byte-identical document from an earlier run must
  // not score a refused write as accepted. `since` alone is not enough — its
  // floor allows 120 s of clock skew, so a value-identical document written
  // seconds earlier still matches. That is exactly the shape of a unique-index
  // probe, where the document causing the refusal is the one the search finds,
  // so capture it first and refuse to treat it as evidence. (Kept in step with
  // the same guard in battery-lib.mjs `attemptCreate`.)
  const since = Date.now();
  const preExisting = await readback(() => findRecentByValues(sdk, { contractId, docType, ownerId: who.ownerId, data }));
  const outcome = await attemptWrite(
    {
      accepted: async (created) => {
        const found = createdId(created) ?? id
          ?? await readback(() => findRecentByValues(sdk, { contractId, docType, ownerId: who.ownerId, data, since }));
        if (found !== null && found === preExisting) return false;
        id = found;
        return id !== null && (await fetchDocument(sdk, contractId, docType, id)) !== null;
      },
    },
    () =>
      sdk.documents.create({
        document,
        identityKey: who.identityKey,
        signer: who.signer,
        ...paymentInfo(tokenCost),
      })
  );
  return { ...outcome, id };
}

/**
 * Creates an INDEX-ONLY document. There is no primary tree, so the caller
 * supplies the acceptance probe (entry-exists for fresh likes, a count bound
 * for duplicate probes — an existing entry satisfies entry-exists and would
 * mask the refusal). The create-returned Document is deliberately discarded.
 */
export async function attemptCreateIndexOnly(sdk, who, { contractId, docType, data, tokenCost, accepted }) {
  const { document } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    entropy: randomIdBytes(),
  });
  return attemptWrite({ accepted }, () =>
    sdk.documents.create({
      document,
      identityKey: who.identityKey,
      signer: who.signer,
      ...paymentInfo(tokenCost),
    })
  );
}

/** Replaces a stored document with a full data set at `revision + 1`. */
export async function attemptReplace(sdk, who, { contractId, docType, id, data, revision }) {
  const nextRevision = revision + 1n;
  const { document } = buildDocument({
    contractId,
    docType,
    ownerId: who.ownerId,
    data,
    revision: nextRevision,
    id: bs58.decode(id),
  });
  return attemptWrite(
    {
      accepted: async () => {
        const d = await fetchDocument(sdk, contractId, docType, id);
        return d?.revision !== undefined && d.revision >= nextRevision;
      },
    },
    () => sdk.documents.replace({ document, identityKey: who.identityKey, signer: who.signer })
  );
}

/**
 * indexOnly delete-by-values: the Document instance carries the whole value
 * tuple (including `$createdAt`, which v5 keeps in `required` for the
 * notification index). `accepted` is supplied because "the entry is gone" is
 * the caller's predicate (and for the foreign-delete probe it never holds).
 */
export async function attemptDeleteByValues(sdk, who, { document, accepted }) {
  return attemptWrite({ accepted }, () =>
    sdk.documents.delete({ document, identityKey: who.identityKey, signer: who.signer })
  );
}

export function expectAccepted(label, outcome) {
  check(label, outcome.ok, outcome.ok ? (outcome.id ? `id=${outcome.id}` : '') : `rejected: ${(outcome.error ?? '').slice(0, 220)}`);
  return outcome;
}

// ---- Expected rejection shapes ---------------------------------------------

// The patterns run against describeErr()'s output, which concatenates the
// error's message AND a JSON dump of it — so the numeric alternatives key on
// the SDK-attached consensus code, the most stable discriminator, while the
// text alternatives document the human-readable message observed live.
//
// Each numeric alternative is ANCHORED to a `code` label rather than matched
// as a bare substring. That JSON dump carries credit amounts, millisecond
// timestamps and nonces, any of which can contain "40127" or "40105" — and a
// rejection scored for the wrong reason is exactly what expectRejected below
// exists to prevent. The optional quote covers the `"code":40127` rendering.

/**
 * propertyAgreement violation (ReferencedDocumentPropertyMismatchError,
 * 40127). Live message: "the document's <p> does not agree with the referenced
 * document's <q> (propertyAgreement on <field>)".
 */
export const PROPERTY_MISMATCH = /\bcode"?\s*[=:]\s*40127\b|does not agree with the referenced document/i;
/** Structural uniqueness / unique index (DuplicateUniqueIndexError family, 40105). */
export const DUPLICATE_UNIQUE = /\bcode"?\s*[=:]\s*40105\b|duplicate unique properties/i;

/**
 * Asserts Platform refused the write FOR THE EXPECTED REASON. A rejection whose
 * text matches no expected pattern FAILS the check: a broken key, an unfunded
 * identity, a transport fault, or a write that silently never landed must never
 * score as enforcement.
 */
export function expectRejected(label, outcome, pattern) {
  const reason = outcome.error ?? '';
  if (outcome.ok) {
    check(label, false, 'ACCEPTED (BAD)');
    return outcome;
  }
  capture(label, reason);
  const matched = pattern.test(reason);
  check(
    label,
    matched,
    matched
      ? reason.slice(0, 220)
      : `rejected, but NOT for the expected reason ${pattern}: ${reason.slice(0, 180)}`
  );
  return outcome;
}
// ---- Topology-independent document shapes ----------------------------------

export const TOKEN_COST = { post: 10, reply: 3, like: 1, likeReply: 1, repost: 1 };
export const likeData = ({ postId, hashtag, postAuthor }) => ({
  postId,
  ...(hashtag === undefined ? {} : { hashtag }),
  postAuthor,
});
export const likeReplyData = ({ replyId, replyAuthor }) => ({ replyId, replyAuthor });
export const repostData = ({ postId, postOwnerId }) => ({ postId, postOwnerId });
export const followData = ({ followingId }) => ({ followingId });
// ---- Identities -------------------------------------------------------------

function poolIdentityIds() {
  const raw = process.env.DEVNET_IDENTITY_IDS ?? '';
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length > 0) return { ids, source: 'DEVNET_IDENTITY_IDS' };
  return { ids: loadIdentityIds(), source: 'E2E_IDENTITY_IDS (set NETWORK=devnet to read .env.devnet)' };
}

async function botSigner(sdk, index, explicitOwnerId) {
  let ownerId = explicitOwnerId;
  if (!ownerId) {
    const { ids, source } = poolIdentityIds();
    ownerId = ids[index];
    if (ownerId) console.log(`     (bot ${index} identity from ${source})`);
  }
  if (!ownerId) {
    throw new Error(`No identity id for bot index ${index}: pass --owner/--owner2 or set DEVNET_IDENTITY_IDS`);
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

/** Aborts before any case runs if a bot cannot pay for its writes. */
async function requireYapp(sdk, contractId, bots) {
  const tokenId = await sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION);
  console.log(`     YAPP token id: ${tokenId}`);
  const balances = await sdk.tokens.balances(bots.map((bot) => bot.ownerId), tokenId);
  const short = [];
  for (const bot of bots) {
    const balance = (balances instanceof Map ? balances.get(bot.ownerId) : undefined) ?? 0n;
    console.log(`     ${bot.label}: ${balance} YAPP`);
    if (balance < MIN_YAPP_BALANCE) short.push(`${bot.ownerId} (${balance})`);
  }
  if (short.length > 0) {
    throw new Error(
      `YAPP balance below ${MIN_YAPP_BALANCE} for ${short.join(', ')} on token ${tokenId}. ` +
      `Fund them from the contract owner (maker, seed index 9).`
    );
  }
}

// ---- CLI, dry run and the report shell --------------------------------------

/**
 * Parses the flags every battery shares. `cases` is the ordered Map of case
 * key → handler, so `--only` can reject an unknown key before connecting.
 */
function parseBatteryArgs(argv, { cases, contractEnvVar }) {
  const args = {
    contract: process.env[contractEnvVar]?.trim() || null,
    botIndex: 0,
    bot2Index: 1,
    ownerId: null,
    owner2Id: null,
    only: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--bot': args.botIndex = Number(argv[++i]); break;
      case '--bot2': args.bot2Index = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--owner2': args.owner2Id = argv[++i]; break;
      case '--only': args.only = argv[++i]; break;
      case '--dry-run':
      case '--self-test': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  for (const [flag, value] of [['--bot', args.botIndex], ['--bot2', args.bot2Index]]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} takes a non-negative integer index`);
  }
  if (args.botIndex === args.bot2Index) {
    throw new Error('--bot and --bot2 must be different identities');
  }
  if (args.only !== null) {
    args.only = args.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (args.only.length === 0) throw new Error('--only takes a comma-separated list of case keys');
    const unknown = args.only.filter((key) => !cases.has(key));
    if (unknown.length > 0) throw new Error(`--only: unknown case(s) ${unknown.join(', ')}`);
  }
  if (!args.contract && !args.dryRun) {
    throw new Error(
      `No contract id: pass --contract <id> or set ${contractEnvVar}. A freshly cut contract ` +
      'has no default — the id only exists after registration day.'
    );
  }
  return args;
}

function selectedCases(args, cases) {
  return [...cases.keys()].filter((key) => !args.only || args.only.includes(key));
}

/**
 * `--dry-run` / `--self-test`: no network, no keys. Proves the arguments parse
 * and that every document shape the battery writes builds cleanly — so a live
 * failure is Platform's answer, not a bug in the battery.
 *
 * `shapes` is `[label, docType, data, createdAt]` per shape the live run
 * writes; `replaceShapes` the same for the replace path, which builds at an
 * explicit revision against a known id.
 */
function dryRun(args, { cases, shapes, replaceShapes = [] }) {
  const contractId = args.contract ?? DRY_RUN_ID;
  const ownerId = args.ownerId ?? DRY_RUN_ID;

  for (const [label, docType, data, createdAt] of shapes) {
    // A fixed nonce so the dry run shows the id the live transition WOULD carry at that nonce.
    const { id } = buildDocument({ contractId, docType, ownerId, data, entropy: randomIdBytes(), createdAt, nonce: 1n });
    console.log(`document shape ok: ${label.padEnd(34)} (${docType}) → ${id}`);
  }
  for (const [label, docType, data] of replaceShapes) {
    buildDocument({ contractId, docType, ownerId, data, revision: 2n, id: bs58.decode(DRY_RUN_ID) });
    console.log(`document shape ok: ${label.padEnd(34)} (${docType}, replace at revision 2)`);
  }

  const { devnetName, addresses } = devnetSdk();
  console.log(
    `would run cases ${selectedCases(args, cases).join(', ')} on devnet "${devnetName}" ` +
    `via ${addresses[0]} (+${addresses.length - 1} more)`
  );
  console.log('DRY RUN OK — no network calls were made');
}

/**
 * The whole battery lifecycle: parse, dry-run-or-connect, run every selected
 * case, print the captured rejections and working shapes, exit non-zero on any
 * failed check. Never returns — it calls `process.exit`.
 *
 * `makeContext({ sdk, contractId, botA, botB })` returns the per-run context
 * the cases share; `summarize(ctx)` prints whatever the battery wants echoed
 * before the verdict.
 */
export async function runBattery({
  name,
  usage,
  contractEnvVar,
  cases,
  shapes,
  replaceShapes,
  makeContext,
  summarize = () => {},
}) {
  let args;
  try {
    args = parseBatteryArgs(process.argv.slice(2), { cases, contractEnvVar });
  } catch (e) {
    console.error(e.message);
    console.error(usage);
    process.exit(1);
  }

  try {
    await ensureInitialized();

    if (args.dryRun) {
      dryRun(args, { cases, shapes, replaceShapes });
      process.exit(0);
    }

    reconnectContractId = args.contract;
    const { sdk: firstSdk, devnetName, addresses, protocolVersion } = await buildConnectedSdk(args.contract);
    activeSdk = firstSdk;
    const sdk = sdkHandle;
    console.log(`protocol version ratcheted via epoch query: PV${protocolVersion ?? '?'}`);
    const botA = await botSigner(sdk, args.botIndex, args.ownerId);
    const botB = await botSigner(sdk, args.bot2Index, args.owner2Id);
    console.log(`connected to devnet "${devnetName}" (${addresses.length} addresses)`);
    console.log(`${name} contract: ${args.contract}`);
    console.log(`A=${botA.label}  B=${botB.label}`);
    console.log('YAPP balances:');
    await requireYapp(sdk, args.contract, [botA, botB]);

    const ctx = makeContext({ sdk, contractId: args.contract, botA, botB });

    for (const key of selectedCases(args, cases)) {
      try {
        await cases.get(key)(ctx);
      } catch (e) {
        check(`${key} completed`, false, `aborted: ${describeErr(e).slice(0, 220)}`);
      }
    }

    if (capturedErrors.length > 0) {
      console.log('\n--- captured rejection texts (verbatim) ---');
      for (const { label, message } of capturedErrors) console.log(`\n[${label}]\n${message}`);
    }
    console.log('');
    summarize(ctx);
    console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR:', describeErr(e));
    process.exit(1);
  }
}
