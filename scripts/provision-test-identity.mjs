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
 * When the faucet demands a captcha and no token is at hand, the request can be
 * made out-of-band (e.g. from the faucet page itself, where its CAP widget runs)
 * and the result fed back in, so the token never has to leave the browser:
 *   node scripts/provision-test-identity.mjs --gen-asset-lock-key <keyfile>   # prints the pubkey to fund
 *   # POST /api/asset-lock-proof elsewhere, save the JSON response, then:
 *   node scripts/provision-test-identity.mjs <index> --asset-lock-key-file <keyfile> --funding-proof-file <json>
 *
 * Never prints the mnemonic or any WIF.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { getPublicKey, utils as secpUtils } from '@noble/secp256k1';
import {
  AssetLockProof,
  EvoSDK,
  Identity,
  IdentityPublicKey,
  IdentitySigner,
  OutPoint,
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
  const args = {
    positional: [], identityIndex: null, dpns: null, topUp: null, capToken: null,
    checkBalances: false, genAssetLockKey: null, assetLockKeyFile: null, fundingProofFile: null,
    chainLockHeight: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dpns': args.dpns = argv[++i]; break;
      case '--topup': args.topUp = argv[++i]; break;
      case '--cap-token': args.capToken = argv[++i]; break;
      case '--check-balances': args.checkBalances = true; break;
      case '--gen-asset-lock-key': args.genAssetLockKey = argv[++i]; break;
      case '--asset-lock-key-file': args.assetLockKeyFile = argv[++i]; break;
      case '--funding-proof-file': args.fundingProofFile = argv[++i]; break;
      case '--chain-lock': args.chainLockHeight = Number(argv[++i]); break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        args.positional.push(arg);
    }
  }

  if (Boolean(args.assetLockKeyFile) !== Boolean(args.fundingProofFile)) {
    throw new Error('--asset-lock-key-file and --funding-proof-file must be used together');
  }
  if (args.checkBalances || args.topUp || args.genAssetLockKey) return args;

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

/** Reads a 64-hex asset-lock private key written by `--gen-asset-lock-key`. */
function loadAssetLockKeypair(keyFile) {
  const hex = readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${keyFile} is not a 64-hex private key`);
  const privateKeyBytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  const publicKeyHex = Buffer.from(getPublicKey(privateKeyBytes, true)).toString('hex');
  return { privateKeyBytes, publicKeyHex };
}

/**
 * The faucet returns the proof as hex-encoded JSON — `{instantLock, transaction,
 * outputIndex}` with base64 payloads — not the bincode blob `fromHex` expects,
 * so build the instant proof from its parts (falling back to `fromHex` should
 * the faucet ever switch to the SDK wire format).
 */
function assetLockProofFromFaucet(proofHex, chainLockHeight) {
  const decoded = Buffer.from(proofHex, 'hex').toString('utf8');
  if (decoded.trimStart().startsWith('{')) {
    const proof = JSON.parse(decoded);
    if (chainLockHeight) {
      // Instant lock proofs go stale once the signing quorum rotates; once the
      // funding tx is buried under a chain lock, `--chain-lock <height>` claims
      // the same outpoint via a chain asset-lock proof instead.
      const tx = Buffer.from(proof.transaction, 'base64');
      const txid = createHash('sha256').update(createHash('sha256').update(tx).digest()).digest().reverse().toString('hex');
      console.log(`using chain asset-lock proof: height=${chainLockHeight} outpoint=${txid}:${proof.outputIndex}`);
      return AssetLockProof.createChainAssetLockProof(chainLockHeight, new OutPoint(txid, proof.outputIndex));
    }
    return AssetLockProof.createInstantAssetLockProof(
      Uint8Array.from(Buffer.from(proof.instantLock, 'base64')),
      Uint8Array.from(Buffer.from(proof.transaction, 'base64')),
      proof.outputIndex,
    );
  }
  return AssetLockProof.fromHex(proofHex);
}

/**
 * Yields the asset-lock keypair plus faucet funding for a create/top-up, either
 * by calling the faucet directly or from files prepared out-of-band (the
 * captcha-in-browser flow described in the header).
 */
async function obtainFunding(args) {
  if (args.fundingProofFile) {
    const assetLock = loadAssetLockKeypair(args.assetLockKeyFile);
    const funding = JSON.parse(readFileSync(args.fundingProofFile, 'utf8'));
    if (!funding.assetLockProof) throw new Error(`${args.fundingProofFile} has no assetLockProof field`);
    console.log(`using pre-fetched asset lock proof: txid=${funding.txid} credits=${funding.creditsAmount}`);
    return { assetLock, funding };
  }
  const assetLock = generateAssetLockKeypair();
  console.log(`requesting asset lock proof from ${FAUCET_URL} …`);
  const funding = await requestAssetLockProof(assetLock.publicKeyHex, args.capToken);
  console.log(`funded: txid=${funding.txid} credits=${funding.creditsAmount}`);
  return { assetLock, funding };
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

  const rawDetail = payload.detail ?? payload.message ?? text;
  const detail = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
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

async function createIdentity(sdk, identityIndex, dpnsLabel, args) {
  const keys = deriveIdentityKeys(identityIndex);
  console.log(`derived ${keys.length} keys for identity index ${identityIndex}`);

  if (dpnsLabel && !(await sdk.dpns.isNameAvailable(dpnsLabel))) {
    throw new Error(`DPNS name "${dpnsLabel}" is already taken — pick another label`);
  }

  const { assetLock, funding } = await obtainFunding(args);

  const assetLockProof = assetLockProofFromFaucet(funding.assetLockProof, args.chainLockHeight);
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

async function topUp(sdk, identityId, args) {
  const identity = await sdk.identities.fetch(identityId);
  if (!identity) throw new Error(`Identity ${identityId} not found on testnet`);

  const { assetLock, funding } = await obtainFunding(args);

  const newBalance = await sdk.identities.topUp({
    identity,
    assetLockProof: assetLockProofFromFaucet(funding.assetLockProof, args.chainLockHeight),
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
  console.error('       node scripts/provision-test-identity.mjs --gen-asset-lock-key <keyfile>');
  console.error('       node scripts/provision-test-identity.mjs <index> --asset-lock-key-file <keyfile> --funding-proof-file <json>');
  process.exit(1);
}

if (args.genAssetLockKey) {
  const assetLock = generateAssetLockKeypair();
  writeFileSync(args.genAssetLockKey, `${Buffer.from(assetLock.privateKeyBytes).toString('hex')}\n`, { mode: 0o600 });
  console.log(`asset-lock private key written to ${args.genAssetLockKey} (mode 600)`);
  console.log(`assetLockPublicKey: ${assetLock.publicKeyHex}`);
  process.exit(0);
}

try {
  const sdk = await connect();
  if (args.checkBalances) {
    await checkBalances(sdk);
  } else if (args.topUp) {
    await topUp(sdk, args.topUp, args);
  } else {
    await createIdentity(sdk, args.identityIndex, args.dpns, args);
  }
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}

process.exit(0);
