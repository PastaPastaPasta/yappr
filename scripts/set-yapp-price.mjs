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
 * Run:  node scripts/set-yapp-price.mjs
 * Signs with the contract-owner ("contract maker") identity's HIGH auth key,
 * read at runtime from the identity JSON in ~/Downloads.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  EvoSDK,
  TokenBaseTransition,
  TokenSetPriceForDirectPurchaseTransition,
  TokenPricingSchedule,
  TokenTransition,
  BatchedTransition,
  BatchTransition,
  PrivateKey,
} from '@dashevo/evo-sdk';

// ---- Config -----------------------------------------------------------------
const CONTRACT_ID = '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9';
const TOKEN_POS = 0;
const MIN_PURCHASE = 100n;          // lowest tier key => minimum tokens per buy
const CREDITS_PER_TOKEN = 1000000n; // P: credits per YAPP at/above the min tier
const SIGNING_KEY_ID = 2;           // CRITICAL auth key (token config transitions require CRITICAL)
const IDENTITY_FILE = join(homedir(), 'Downloads', 'dash-identity-testnet-contract-maker.json');
// -----------------------------------------------------------------------------

function describeErr(e) {
  if (!e) return String(e);
  const parts = [];
  for (const k of ['message', 'name', 'code', 'cause']) if (e[k] !== undefined) parts.push(`${k}=${e[k]}`);
  try { parts.push(`toString=${e.toString()}`); } catch {}
  try { parts.push(`json=${JSON.stringify(e)}`); } catch {}
  try { parts.push(`keys=${Object.keys(e).join(',')}`); } catch {}
  return parts.join(' | ');
}

const identityJson = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
const OWNER_ID = identityJson.identityId;
const signingKey = (identityJson.identityKeys || []).find((k) => k.id === SIGNING_KEY_ID);
if (!signingKey?.privateKeyWif) throw new Error(`No privateKeyWif for key id ${SIGNING_KEY_ID}`);
console.log(`owner=${OWNER_ID} signingKeyId=${SIGNING_KEY_ID} (${signingKey.securityLevel})`);

const sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: 30000 } });
await sdk.connect();
const wasm = sdk.wasm;
console.log('connected');

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

  st.sign(PrivateKey.fromWIF(signingKey.privateKeyWif), identityKey);
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
