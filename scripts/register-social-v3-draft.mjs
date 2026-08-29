/**
 * One-time, manual registration of a yappr social **v3** contract on a devnet
 * (moutai by default).
 *
 * Publishes a contract JSON from `contracts/` as a brand-new contract. Two files
 * are in play, selected with `--contract-file`:
 *
 *   `yappr-social-contract-v3-draft.json`    (default)
 *      The staging chain's canonical schemas plus exactly two additions —
 *      `follow.followingId` and `postMention.mentionedUserId` both gain
 *      `"refersTo": { "type": "identity" }` — so consensus refuses a follow or
 *      a mention that points at an identity which does not exist.
 *
 *   `yappr-social-contract-v3-topology.json`
 *      The full interaction topology from PLAN_CONTRACT_V3_TOPOLOGY.md: flat
 *      threads (`reply.rootPostId` + `replyToReplyId`), the new `likeReply`
 *      doctype, posts-only repost/bookmark, dual quote fields with the
 *      uniqueness dropped, `canBeDeleted:false` on post+reply, and
 *      `permanentDocument` refersTo on every same-contract reference.
 *
 * ## Registered devnet contracts
 *
 *   v3-draft    3414JJ3xGXK3Cgpy7NAdDXwAjvyoeD4bcBTX6nSh7ysg  (moutai, 2026-08-27)
 *   v3-topology GwGV4Gkb5Vb6VE2m45DnSpKQEha41amSxiopK9eo9WnG  (moutai, 2026-08-27)
 *               owner = devnet maker DuqE3zgXprS5zU51YaB4GuGxTRzzukW59XAYKeM6gKGA (seed index 9);
 *               `verify-topology.mjs` passed all 31 checks against it.
 *
 *   v3-topology 4UW9im1ytErbtstoNoFzdWbCHXk8qYaJvM9gkZQ86wbb  (moutai, 2026-08-29)
 *               same file with post/reply.mediaUrl relaxed to
 *               `^(https?|ipfs)://.+$`, so image attachments are stored
 *               natively as ipfs://CID. dataContractUpdate cannot change an
 *               existing property's pattern, which is why this is a fresh
 *               registration rather than an update of the id above. Battery
 *               passed; ipfs:// and https:// mediaUrl writes both verified
 *               accepted on chain. This is the id in .env.devnet.
 *
 * Devnet is disposable; iterate freely.
 *
 * ## Network
 *
 * Devnet only, on purpose: `refersTo` needs protocol v14, testnet is still on
 * v13. Configured from the environment so this script needs no edit when the
 * devnet is re-genesised:
 *
 *   DEVNET_NAME     devnet name           (default: moutai)
 *   DAPI_ADDRESSES  comma-separated DAPI  (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *
 * Non-trusted, proofs off: a devnet has no published quorum info to verify
 * against, so every query is served in trusted mode against the seeds above.
 *
 * ## The `tokens` block
 *
 * The v3-draft carries the YAPP token configuration (`post` costs 10 YAPP,
 * `reply` 3, `like`/`repost` 1). `new DataContract({ownerId, identityNonce,
 * schemas})` — the shape `register-pollr-contract.mjs` uses — cannot express it:
 * its optional `tokens` field is typed `Record<number, TokenConfiguration>` and
 * the wasm constructor rejects a plain object with "JS object constructor name
 * mismatch. Expected TokenConfiguration". Building real `TokenConfiguration`
 * instances would mean hand-assembling the whole nested wasm object graph
 * (ChangeControlRules, TokenDistributionRules, TokenMarketplaceRules, …).
 *
 * `DataContract.fromJSON(json, fullValidation, platformVersion)` does accept the
 * plain-object form and round-trips the token configuration intact, so that is
 * the path taken here. Verified locally against @dashevo/evo-sdk 4.2.0-dev.1.
 *
 * ## Owner
 *
 * `--maker` reads the contract-maker key file (see owner-keys.mjs); `--bot <n>`
 * derives from `E2E_SEED_PHRASE`. Identity **ids** are not derivable, and the
 * devnet ids differ from the testnet ones, so on devnet pass the id explicitly:
 *
 *   node scripts/register-social-v3-draft.mjs --bot 0 --owner <devnetIdentityId>
 *
 * ## Funding the bot pool
 *
 * A fresh contract mints its whole YAPP `baseSupply` to the contract owner, so
 * every other identity starts at zero and its first token-priced write (a post
 * costs 10 YAPP) is refused. `--fund <id>[,<id>…]` transfers `--fund-amount`
 * YAPP from the freshly-registered contract's owner to each id, which is what
 * makes the verification battery able to write posts/replies/likes at all.
 * `--fund-only <contractId>` performs just that step against a contract that
 * already exists, for topping a bot up without republishing anything.
 *
 * `--dry-run` assembles and validates the contract locally and prints a summary
 * without touching the network.
 *
 * Run:  node scripts/register-social-v3-draft.mjs (--bot <index> | --maker) [--owner <identityId>]
 *       [--contract-file <name|path>] [--fund <id,id>] [--fund-amount <n>] [--dry-run]
 *       node scripts/register-social-v3-draft.mjs --bot <index> --owner <id> --fund-only <contractId> --fund <id,id>
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataContract, EvoSDK, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts');
const DEFAULT_CONTRACT_FILE = 'yappr-social-contract-v3-draft.json';
/** YAPP is defined at token position 0 of every yappr social contract. */
const YAPP_TOKEN_POSITION = 0;
/** Enough YAPP for a battery run: posts cost 10, replies 3, likes/reposts 1. */
const DEFAULT_FUND_AMOUNT = 1000n;
const SDK_TIMEOUT_MS = 30000;
const DEFAULT_DEVNET_NAME = 'moutai';
const DEFAULT_SEED_COUNT = 5;
/** Placeholder owner for `--dry-run`, so the contract can be assembled without an identity. */
const DRY_RUN_OWNER = '11111111111111111111111111111111';

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
    // trusted mode is mandatory: wasm-sdk panics on `proofs: false` ("queries
    // without proofs are not supported yet") and refuses non-trusted proofs.
    // The trusted context prefetches quorum keys from
    // https://quorums.<devnetName>.networks.dash.org (or QUORUM_URL).
    trusted: true,
    ...(process.env.QUORUM_URL ? { quorumUrl: process.env.QUORUM_URL } : {}),
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- Contract assembly ------------------------------------------------------

/** Resolves `--contract-file` (bare name, relative or absolute path) to a path. */
function contractPath(name) {
  if (name.includes('/') || isAbsolute(name)) return name;
  return join(CONTRACTS_DIR, name);
}

/**
 * Reads a contract JSON and turns it into a publishable `DataContract` owned by
 * `ownerId`. `identityNonce` seeds a locally-derived id; the authoritative id is
 * whatever `contracts.publish` returns, which is what gets printed.
 */
function buildDraftContract({ contractFile, ownerId, identityNonce, platformVersion }) {
  const file = JSON.parse(readFileSync(contractFile, 'utf8'));
  if (!file.documentSchemas || Object.keys(file.documentSchemas).length === 0) {
    throw new Error(`${contractFile} has no documentSchemas`);
  }
  const json = {
    $formatVersion: file.$formatVersion ?? '1',
    id: DataContract.generateId(ownerId, identityNonce).toBase58(),
    ownerId,
    version: file.version ?? 1,
    documentSchemas: file.documentSchemas,
    ...(file.config ? { config: file.config } : {}),
    ...(file.tokens ? { tokens: file.tokens } : {}),
  };
  return { dataContract: DataContract.fromJSON(json, true, platformVersion), file };
}

/** Width of the doctype-name column in the audit, so wrapped lines line up. */
const AUDIT_NAME_WIDTH = 18;

/** `name[a,b]` with `(u)` for unique and `(c)` for countable indexes. */
function describeIndex(index) {
  const properties = (index.properties ?? []).map((entry) => Object.keys(entry)[0]).join(',');
  return `${index.name}${index.unique ? '(u)' : ''}${index.countable ? '(c)' : ''}[${properties}]`;
}

/**
 * Per-doctype audit: permanence flags, index set, token price and outgoing
 * references. Printed before publishing so a wrong file, a dropped index or a
 * missing `canBeDeleted: false` on a reference target is caught by eye rather
 * than by a consensus rejection ten seconds later — or worse, by a contract
 * that registers fine and then cannot be pointed at.
 */
function printSchemaAudit(documentSchemas) {
  const continuation = ' '.repeat(AUDIT_NAME_WIDTH);
  for (const name of Object.keys(documentSchemas).sort()) {
    const schema = documentSchemas[name];
    const flags = [
      `mutable=${schema.documentsMutable ?? 'default'}`,
      `canBeDeleted=${schema.canBeDeleted ?? 'default'}`,
      ...(schema.documentsCountable ? ['countable'] : []),
    ];
    const cost = schema.tokenCost?.create;
    if (cost) flags.push(`create=${cost.amount} token@${cost.tokenPosition}`);
    const indices = (schema.indices ?? []).map(describeIndex);
    console.log(`  ${name.padEnd(AUDIT_NAME_WIDTH)} ${flags.join(' ')}  (${indices.length} indexes)`);
    if (indices.length > 0) console.log(`  ${continuation} ${indices.join(' ')}`);
    // Covers both `refersTo` shapes the contracts use: `{type: 'identity'}` and
    // `{type: 'permanentDocument', documentType}`.
    const refs = Object.entries(schema.properties ?? {})
      .filter(([, property]) => property.refersTo)
      .map(([property, { refersTo }]) =>
        `${property}→${refersTo.type}${refersTo.documentType ? `(${refersTo.documentType})` : ''}`);
    if (refs.length > 0) console.log(`  ${continuation} refersTo: ${refs.join(' ')}`);
  }

  // A reference target that stays deletable is refused at registration (40122),
  // so surface the mismatch here where the fix is obvious.
  const targets = new Set();
  for (const schema of Object.values(documentSchemas)) {
    for (const property of Object.values(schema.properties ?? {})) {
      if (property.refersTo?.type === 'permanentDocument') targets.add(property.refersTo.documentType);
    }
  }
  for (const target of targets) {
    const schema = documentSchemas[target];
    if (!schema) throw new Error(`refersTo names document type "${target}", which this contract does not define`);
    if (schema.canBeDeleted !== false) {
      throw new Error(`document type "${target}" is a permanentDocument target but is not canBeDeleted: false`);
    }
  }
  console.log(`  permanentDocument targets: ${targets.size > 0 ? [...targets].join(', ') : 'none'} (all canBeDeleted:false)`);
}

/**
 * Transfers YAPP from the contract owner (who holds the whole freshly-minted
 * `baseSupply`) to each recipient, so their first token-priced document write is
 * not refused for an empty balance.
 */
async function fundRecipients(sdk, { contractId, owner, identityKey, signer, recipients, amount }) {
  // The trusted SDK needs the contract cached before it can verify a token
  // result proof, otherwise waitForResponse fails with "unknown contract".
  await sdk.contracts.fetch(contractId);
  const tokenId = await sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION);
  console.log(`funding ${recipients.length} identity(ies) with ${amount} YAPP each (token ${tokenId}) …`);

  for (const recipientId of recipients) {
    try {
      await sdk.tokens.transfer({
        dataContractId: contractId,
        tokenPosition: YAPP_TOKEN_POSITION,
        senderId: owner.ownerId,
        recipientId,
        amount,
        identityKey,
        signer,
      });
    } catch (e) {
      // A gateway timeout on a transfer that landed must not look like a
      // failure, so the balance read below is what decides.
      console.log(`  transfer to ${recipientId} reported: ${describeErr(e).slice(0, 160)}`);
    }
  }

  const balances = await sdk.tokens.balances(recipients, tokenId);
  for (const recipientId of recipients) {
    const balance = balances instanceof Map ? balances.get(recipientId) : undefined;
    console.log(`  ${recipientId}: ${balance ?? 0} YAPP`);
    if (!balance || balance < amount) {
      console.log('  WARNING: funding did not land — token-priced writes will be refused for this identity.');
    }
  }
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    maker: false,
    botIndex: null,
    ownerId: null,
    contractFile: DEFAULT_CONTRACT_FILE,
    fund: [],
    fundAmount: DEFAULT_FUND_AMOUNT,
    fundOnly: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--maker': args.maker = true; break;
      case '--bot': args.botIndex = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--contract-file': args.contractFile = argv[++i]; break;
      case '--fund': args.fund = argv[++i].split(',').map((id) => id.trim()).filter(Boolean); break;
      case '--fund-amount': args.fundAmount = BigInt(argv[++i]); break;
      case '--fund-only': args.fundOnly = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dryRun && args.maker === (args.botIndex !== null)) {
    throw new Error('Pass exactly one of --maker or --bot <index>');
  }
  if (args.botIndex !== null && !Number.isInteger(args.botIndex)) {
    throw new Error('--bot takes an integer index');
  }
  if (!args.contractFile) throw new Error('--contract-file takes a file name under contracts/ or a path');
  if (args.fundAmount <= 0n) throw new Error('--fund-amount takes a positive integer');
  if (args.fundOnly && args.fund.length === 0) {
    throw new Error('--fund-only also needs --fund <id,id> naming the recipients');
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error(
    'Usage: node scripts/register-social-v3-draft.mjs (--bot <index> | --maker) [--owner <identityId>]\n' +
    '       [--contract-file <name|path>] [--fund <id,id>] [--fund-amount <n>] [--dry-run]'
  );
  process.exit(1);
}

const contractFile = contractPath(args.contractFile);

try {
  await ensureInitialized();
  const platformVersion = PlatformVersion.current();

  if (args.dryRun) {
    // No identity, no network: prove the JSON assembles into a valid contract.
    const ownerId = args.ownerId ?? DRY_RUN_OWNER;
    const { dataContract, file } = buildDraftContract({ contractFile, ownerId, identityNonce: 1n, platformVersion });
    const roundTrip = dataContract.toJSON(platformVersion);
    console.log(`dry run: ${contractFile}`);
    console.log(`  document types : ${Object.keys(roundTrip.documentSchemas).length}`);
    const tokenPositions = Object.keys(roundTrip.tokens ?? {});
    console.log(
      tokenPositions.length > 0
        ? `  tokens         : ${tokenPositions.length} (positions ${tokenPositions.join(', ')})`
        : '  tokens         : NONE — the token block was lost in assembly'
    );
    console.log(`  provisional id : ${roundTrip.id}`);
    printSchemaAudit(file.documentSchemas);
    if (args.fund.length > 0) {
      console.log(`  would fund     : ${args.fund.join(', ')} with ${args.fundAmount} YAPP each`);
    }
    const { devnetName, addresses } = devnetSdk();
    console.log(`  would publish to devnet "${devnetName}" via ${addresses.join(', ')}`);
    process.exit(0);
  }

  const owner = resolveOwner(args);
  const { sdk, devnetName, addresses } = devnetSdk();
  await sdk.connect();
  console.log(`connected to devnet "${devnetName}" (${addresses.length} addresses); owner=${owner.label}`);

  const { identityKey, signer } = await signerFor(sdk, owner);

  if (args.fundOnly) {
    // Top up an existing contract's bot pool; nothing is published.
    await fundRecipients(sdk, {
      contractId: args.fundOnly,
      owner,
      identityKey,
      signer,
      recipients: args.fund,
      amount: args.fundAmount,
    });
    process.exit(0);
  }

  const identityNonce = ((await sdk.identities.nonce(owner.ownerId)) ?? 0n) + 1n;

  const { dataContract, file } = buildDraftContract({
    contractFile,
    ownerId: owner.ownerId,
    identityNonce,
    platformVersion,
  });
  console.log(`contract file: ${contractFile}`);
  printSchemaAudit(file.documentSchemas);

  console.log(`publishing yappr social contract (${Object.keys(file.documentSchemas).length} document types) …`);
  const published = await sdk.contracts.publish({ dataContract, identityKey, signer });
  const contractId = published.id.toBase58();

  // A dropped token block would only show up much later, as "insufficient token
  // balance" on the first post, so check it here while the contract is fresh.
  const publishedTokens = published.toJSON(platformVersion).tokens;
  const tokenCount = publishedTokens ? Object.keys(publishedTokens).length : 0;
  console.log(`yappr social contract published: ${contractId}`);
  console.log(`token configurations on the published contract: ${tokenCount}`);
  if (tokenCount === 0) {
    console.log('WARNING: the token block did not survive publication — posts will not be payable.');
  }

  if (args.fund.length > 0) {
    console.log('');
    await fundRecipients(sdk, {
      contractId,
      owner,
      identityKey,
      signer,
      recipients: args.fund,
      amount: args.fundAmount,
    });
  }

  console.log('');
  console.log(`.env.devnet → NEXT_PUBLIC_YAPPR_CONTRACT_ID=${contractId}`);
  console.log(`battery     → node scripts/verify-topology.mjs --contract ${contractId} …`);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
process.exit(0);
