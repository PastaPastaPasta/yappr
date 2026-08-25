/**
 * One-time, manual provisioning of the e2e bot identities on Dash testnet.
 *
 * Identity keys are derived deterministically from `E2E_SEED_PHRASE`
 * (see scripts/derive-identities.mjs). The asset-lock keypair funding each
 * registration is a random one-shot: only the resulting proof matters, and the
 * identity ID comes from the asset-lock outpoint — which is why the IDs are
 * recorded in `.env.testing` rather than derived.
 *
 * Faucet etiquette (https://faucet.thepasta.org): one request at a time, honour
 * `retryAfter` on 429, and solve the captcha in the web UI when asked. This is a
 * rare manual operation — never run it from CI.
 *
 * Run:
 *   node scripts/provision-test-identity.mjs <index> [--dpns <label>] [--cap-token <t>]
 *   node scripts/provision-test-identity.mjs --topup <identityId> [--cap-token <t>]
 *   node scripts/provision-test-identity.mjs --check-balances
 *
 * Never prints the mnemonic or any WIF.
 */
import { getPublicKey, utils as secpUtils } from '@noble/secp256k1';
import {
  AssetLockProof,
  EvoSDK,
  Identity,
  IdentityPublicKey,
  IdentitySigner,
  PrivateKey,
} from '@dashevo/evo-sdk';
import { CRITICAL_AUTH_KEY_ID, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';

// ---- Config -----------------------------------------------------------------
const FAUCET_URL = 'https://faucet.thepasta.org';
const MIN_BALANCE_CREDITS = 100000000n; // below this, the identity can't reliably finish a write suite
const SDK_TIMEOUT_MS = 30000;
// -----------------------------------------------------------------------------

/** Compressed testnet WIFs, so a key echoed back inside an error never reaches the console. */
const WIF_PATTERN = /\b[c9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;

function describeErr(e) {
  if (!e) return String(e);
  const parts = [];
  for (const k of ['message', 'name', 'code', 'cause']) if (e[k] !== undefined) parts.push(`${k}=${e[k]}`);
  try { parts.push(`toString=${e.toString()}`); } catch {}
  try { parts.push(`json=${JSON.stringify(e)}`); } catch {}
  return parts.join(' | ').replace(WIF_PATTERN, '<redacted-key>');
}

function parseArgs(argv) {
  const args = { positional: [], identityIndex: null, dpns: null, topUp: null, capToken: null, checkBalances: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dpns': args.dpns = argv[++i]; break;
      case '--topup': args.topUp = argv[++i]; break;
      case '--cap-token': args.capToken = argv[++i]; break;
      case '--check-balances': args.checkBalances = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        args.positional.push(arg);
    }
  }

  if (args.checkBalances || args.topUp) return args;

  args.identityIndex = Number(args.positional[0]);
  if (args.positional.length !== 1 || !Number.isInteger(args.identityIndex) || args.identityIndex < 0) {
    throw new Error('Expected a non-negative identity index, --topup <identityId>, or --check-balances');
  }
  return args;
}

/** Random one-shot secp256k1 keypair that will control the asset-lock output. */
function generateAssetLockKeypair() {
  const privateKeyBytes = secpUtils.randomSecretKey();
  const publicKeyHex = Buffer.from(getPublicKey(privateKeyBytes, true)).toString('hex');
  return { privateKeyBytes, publicKeyHex };
}

/**
 * Asks the faucet to fund `publicKeyHex` and return the asset-lock proof.
 * Surfaces the documented operational responses with actionable instructions
 * instead of retrying — the caller is a human at a terminal.
 */
async function requestAssetLockProof(publicKeyHex, capToken) {
  const body = { assetLockPublicKey: publicKeyHex };
  if (capToken) body.capToken = capToken;

  const response = await fetch(`${FAUCET_URL}/api/asset-lock-proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { detail: text }; }

  if (response.ok) {
    if (!payload.assetLockProof) throw new Error(`Faucet returned no assetLockProof: ${text}`);
    return payload;
  }

  const detail = String(payload.detail ?? payload.message ?? text);
  if (response.status === 400 && /captcha|cap token|captoken/i.test(detail)) {
    throw new Error(
      `Faucet requires a captcha token: ${detail}\n` +
      `  Solve it in the web UI at ${FAUCET_URL}/ and re-run with --cap-token <token>.`
    );
  }
  if (response.status === 429) {
    const retryAfter = payload.retryAfter ?? response.headers.get('retry-after') ?? 'unknown';
    throw new Error(
      `Faucet rate limit hit (retryAfter=${retryAfter}s). Stopping — do not retry automatically.` +
      (payload.requiresHardCaptcha ? '\n  A hard captcha is now required; use the web UI.' : '')
    );
  }
  if (response.status === 503) {
    throw new Error(
      `Faucet is unavailable (503): ${detail}\n` +
      `  Low balance, no suitable UTXO, or an InstantSend timeout. If a txid was reported, the funding` +
      ` transaction may already be broadcast — check before requesting again.`
    );
  }
  throw new Error(`Faucet request failed (${response.status}): ${detail}`);
}

async function connect() {
  const sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: SDK_TIMEOUT_MS } });
  await sdk.connect();
  console.log('connected to testnet');
  return sdk;
}

async function createIdentity(sdk, identityIndex, dpnsLabel, capToken) {
  const keys = deriveIdentityKeys(identityIndex);
  console.log(`derived ${keys.length} keys for identity index ${identityIndex}`);

  if (dpnsLabel && !(await sdk.dpns.isNameAvailable(dpnsLabel))) {
    throw new Error(`DPNS name "${dpnsLabel}" is already taken — pick another label`);
  }

  const assetLock = generateAssetLockKeypair();
  console.log(`requesting asset lock proof from ${FAUCET_URL} …`);
  const funding = await requestAssetLockProof(assetLock.publicKeyHex, capToken);
  console.log(`funded: txid=${funding.txid} credits=${funding.creditsAmount}`);

  const assetLockProof = AssetLockProof.fromHex(funding.assetLockProof);
  const identityId = assetLockProof.createIdentityId();

  const identity = new Identity(identityId);
  const signer = new IdentitySigner();
  for (const key of keys) {
    identity.addPublicKey(new IdentityPublicKey({
      keyId: key.keyIndex,
      purpose: key.purpose.toLowerCase(),
      securityLevel: key.securityLevel.toLowerCase(),
      keyType: key.keyType.toLowerCase(),
      isReadOnly: false,
      data: key.publicKey,
    }));
    signer.addKeyFromWif(key.wif);
  }

  console.log(`registering identity ${identityId.toBase58()} …`);
  await sdk.identities.create({
    identity,
    assetLockProof,
    assetLockPrivateKey: PrivateKey.fromBytes(assetLock.privateKeyBytes, 'testnet'),
    signer,
  });

  const identityIdBase58 = identityId.toBase58();
  const balance = await sdk.identities.balance(identityIdBase58);
  console.log(`identity registered: ${identityIdBase58}  balance=${balance} credits`);

  if (dpnsLabel) {
    const registered = await sdk.identities.fetch(identityIdBase58);
    if (!registered) throw new Error(`Identity ${identityIdBase58} not readable after creation`);
    const identityKey = registered.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
    if (!identityKey) throw new Error(`Identity ${identityIdBase58} has no key ${CRITICAL_AUTH_KEY_ID}`);
    console.log(`registering DPNS name "${dpnsLabel}" …`);
    await sdk.dpns.registerName({ label: dpnsLabel, identity: registered, identityKey, signer });
    console.log(`DPNS name registered: ${dpnsLabel}.dash`);
  }

  console.log('');
  console.log(`Append ${identityIdBase58} to E2E_IDENTITY_IDS in .env.testing (index ${identityIndex} order).`);
}

async function topUp(sdk, identityId, capToken) {
  const identity = await sdk.identities.fetch(identityId);
  if (!identity) throw new Error(`Identity ${identityId} not found on testnet`);

  const assetLock = generateAssetLockKeypair();
  console.log(`requesting asset lock proof from ${FAUCET_URL} …`);
  const funding = await requestAssetLockProof(assetLock.publicKeyHex, capToken);
  console.log(`funded: txid=${funding.txid} credits=${funding.creditsAmount}`);

  const newBalance = await sdk.identities.topUp({
    identity,
    assetLockProof: AssetLockProof.fromHex(funding.assetLockProof),
    assetLockPrivateKey: PrivateKey.fromBytes(assetLock.privateKeyBytes, 'testnet'),
  });
  console.log(`topped up ${identityId}: balance=${newBalance} credits`);
}

async function checkBalances(sdk) {
  const identityIds = loadIdentityIds();
  if (identityIds.length === 0) {
    throw new Error('E2E_IDENTITY_IDS is empty — run the provisioning runbook first');
  }

  const depleted = [];
  for (const identityId of identityIds) {
    const balance = await sdk.identities.balance(identityId);
    const credits = balance ?? 0n;
    console.log(`${identityId}: ${credits} credits`);
    if (credits < MIN_BALANCE_CREDITS) depleted.push(identityId);
  }

  if (depleted.length > 0) {
    for (const identityId of depleted) {
      console.error(`run scripts/provision-test-identity.mjs --topup ${identityId}`);
    }
    process.exit(1);
  }
  console.log(`all ${identityIds.length} identities are above ${MIN_BALANCE_CREDITS} credits`);
}

// ---- Main -------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/provision-test-identity.mjs <index> [--dpns <label>] [--cap-token <t>]');
  console.error('       node scripts/provision-test-identity.mjs --topup <identityId> [--cap-token <t>]');
  console.error('       node scripts/provision-test-identity.mjs --check-balances');
  process.exit(1);
}

try {
  const sdk = await connect();
  if (args.checkBalances) {
    await checkBalances(sdk);
  } else if (args.topUp) {
    await topUp(sdk, args.topUp, args.capToken);
  } else {
    await createIdentity(sdk, args.identityIndex, args.dpns, args.capToken);
  }
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}

process.exit(0);
