/**
 * One-shot: set the YAPP token's tiered direct-purchase price on the v2 contract.
 *
 * The JS SDK facade `sdk.tokens.setPrice` only supports a flat price, so this
 * builds the TokenSetPriceForDirectPurchase transition manually with a tiered
 * `SetPrices` schedule to enforce the minimum bulk buy-in (the anti-spam bond).
 *
 * SetPrices semantics (verified against rs-drive transformer):
 *   SetPrices({ "100": P }) => buying N tokens requires N >= 100 (lowest tier
 *   key), priced at P credits PER TOKEN (total = N * P). Buying < 100 fails with
 *   TokenAmountUnderMinimumSaleAmount.
 *
 * Run:  node scripts/set-yapp-price.mjs [--contract <id>] [--owner-index <n>]
 *
 * The signing identity is the contract owner ("contract maker"). On testnet that
 * is the identity JSON in ~/Downloads; pass `--owner-index <n>` to sign with a
 * seed-derived identity instead (how the devnet maker at seed index 9 is used,
 * see .env.devnet), in which case `--owner` supplies its identity id.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  TokenBaseTransition,
  TokenSetPriceForDirectPurchaseTransition,
  TokenPricingSchedule,
  TokenTransition,
  BatchedTransition,
  BatchTransition,
  PrivateKey,
} from '@dashevo/evo-sdk';
import { CRITICAL_AUTH_KEY_ID, deriveIdentityKeys } from './derive-identities.mjs';
import { connectSdk } from './sdk-env.mjs';

// ---- Config -----------------------------------------------------------------
const DEFAULT_CONTRACT_ID = '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9';
const TOKEN_POS = 0;
const MIN_PURCHASE = 100n;          // lowest tier key => minimum tokens per buy
const CREDITS_PER_TOKEN = 1000000n; // P: credits per YAPP at/above the min tier
const IDENTITY_FILE = join(homedir(), 'Downloads', 'dash-identity-testnet-contract-maker.json');
// -----------------------------------------------------------------------------

/** Compressed testnet WIFs, so a key echoed back inside an error never reaches the console. */
const WIF_PATTERN = /\b[c9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;

function describeErr(e) {
  if (!e) return String(e);
  const parts = [];
  for (const k of ['message', 'name', 'code', 'cause']) if (e[k] !== undefined) parts.push(`${k}=${e[k]}`);
  try { parts.push(`toString=${e.toString()}`); } catch {}
  try { parts.push(`json=${JSON.stringify(e)}`); } catch {}
  try { parts.push(`keys=${Object.keys(e).join(',')}`); } catch {}
  return parts.join(' | ').replace(WIF_PATTERN, '<redacted-key>');
}

function parseArgs(argv) {
  const args = { contract: DEFAULT_CONTRACT_ID, ownerIndex: null, owner: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': args.contract = argv[++i]; break;
      case '--owner': args.owner = argv[++i]; break;
      case '--owner-index': args.ownerIndex = Number(argv[++i]); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (args.ownerIndex !== null) {
    if (!Number.isInteger(args.ownerIndex) || args.ownerIndex < 0) {
      throw new Error('--owner-index takes a non-negative integer');
    }
    if (!args.owner) throw new Error('--owner-index also needs --owner <identityId>');
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/set-yapp-price.mjs [--contract <id>] [--owner <identityId> --owner-index <n>]');
  process.exit(1);
}

const CONTRACT_ID = args.contract;
// Token config transitions require a CRITICAL authentication key. On the
// ~/Downloads maker that is key id 2; on a seed-derived identity it is key id 1
// (see KEY_ROLES in derive-identities.mjs).
let OWNER_ID;
let SIGNING_KEY_ID;
let signingWif;
if (args.ownerIndex !== null) {
  const key = deriveIdentityKeys(args.ownerIndex).find((k) => k.keyIndex === CRITICAL_AUTH_KEY_ID);
  if (!key) throw new Error(`No key ${CRITICAL_AUTH_KEY_ID} derived at index ${args.ownerIndex}`);
  OWNER_ID = args.owner;
  SIGNING_KEY_ID = CRITICAL_AUTH_KEY_ID;
  signingWif = key.wif;
  console.log(`owner=${OWNER_ID} signingKeyId=${SIGNING_KEY_ID} (seed index ${args.ownerIndex})`);
} else {
  const identityJson = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
  OWNER_ID = args.owner ?? identityJson.identityId;
  SIGNING_KEY_ID = 2;
  const signingKey = (identityJson.identityKeys || []).find((k) => k.id === SIGNING_KEY_ID);
  if (!signingKey?.privateKeyWif) throw new Error(`No privateKeyWif for key id ${SIGNING_KEY_ID}`);
  signingWif = signingKey.privateKeyWif;
  console.log(`owner=${OWNER_ID} signingKeyId=${SIGNING_KEY_ID} (${signingKey.securityLevel})`);
}

const sdk = await connectSdk({ timeoutMs: 30000 });
const wasm = sdk.wasm;

// PROTOCOL-VERSION RATCHET (load-bearing on devnet): one proved non-contract
// query teaches the SDK the chain's real protocol version — without it the
// first proved read of a v14-grammar contract fails inside proof verification.
await sdk.epoch.current();

// Cache the contract so the trusted SDK can verify the result proof at
// waitForResponse (otherwise: "unknown contract ... in token verification").
await sdk.contracts.fetch(CONTRACT_ID);

const tokenId = await sdk.tokens.calculateId(CONTRACT_ID, TOKEN_POS);
console.log('tokenId:', tokenId);

// DIP-30 identity-contract nonce: lower 40 bits = sequence; increment that.
const SEQUENCE_MASK = (1n << 40n) - 1n;
const rawNonce = (await wasm.getIdentityContractNonce(OWNER_ID, CONTRACT_ID)) ?? 0n;
const nonce = (rawNonce & SEQUENCE_MASK) + 1n;
console.log(`nonce: raw=${rawNonce} using=${nonce}`);

let st;
try {
  const base = new TokenBaseTransition({
    identityContractNonce: nonce,
    tokenContractPosition: TOKEN_POS,
    dataContractId: CONTRACT_ID,
    tokenId,
  });
  console.log('built TokenBaseTransition');

  // NOTE: this SDK's wasm binding for SetPrices rejects a BigInt value
  // ("Price for amount '100' must be an integer") and requires a JS number.
  // Guard against the >2^53 precision cliff since CREDITS_PER_TOKEN is a Number here.
  if (CREDITS_PER_TOKEN > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('CREDITS_PER_TOKEN exceeds Number.MAX_SAFE_INTEGER; SetPrices needs a safe-integer price');
  }
  const schedule = TokenPricingSchedule.SetPrices({ [MIN_PURCHASE.toString()]: Number(CREDITS_PER_TOKEN) });
  console.log('built SetPrices schedule');
  const setPriceTx = new TokenSetPriceForDirectPurchaseTransition({
    base,
    price: schedule,
    publicNote: `min ${MIN_PURCHASE} @ ${CREDITS_PER_TOKEN} credits/token`,
  });
  console.log('built TokenSetPriceForDirectPurchaseTransition');

  const tokenTransition = new TokenTransition(setPriceTx);
  const batched = new BatchedTransition(tokenTransition);
  const batchTransition = BatchTransition.fromBatchedTransitions([batched], OWNER_ID, 0);
  st = batchTransition.toStateTransition();
  st.setIdentityContractNonce(nonce);

  const identity = await sdk.identities.fetch(OWNER_ID);
  const identityKey = identity.getPublicKeyById(SIGNING_KEY_ID);
  if (!identityKey) throw new Error(`public key ${SIGNING_KEY_ID} not found on identity`);

  st.sign(PrivateKey.fromWIF(signingWif), identityKey);
  console.log('signed; broadcasting...');
} catch (e) {
  console.error('BUILD/SIGN ERROR:', describeErr(e));
  process.exit(1);
}

try {
  await sdk.stateTransitions.broadcastStateTransition(st);
  await sdk.stateTransitions.waitForResponse(st);
  console.log('broadcast confirmed');
} catch (e) {
  const msg = (e?.message || String(e)).toLowerCase();
  // The trusted SDK can't verify the result proof for a just-registered contract
  // ("unknown contract ... in token verification"). The transition still applies —
  // confirm by reading the price back rather than failing.
  if (msg.includes('unknown contract')) {
    console.warn('wait proof unverifiable (unknown contract) — confirming via price read…');
  } else {
    console.error('BROADCAST ERROR:', describeErr(e));
    process.exit(1);
  }
}

const prices = await sdk.tokens.directPurchasePrices([tokenId]);
console.log('directPurchasePrices now:', prices);

process.exit(0);
