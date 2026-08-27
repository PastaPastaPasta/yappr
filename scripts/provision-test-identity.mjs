/**
 * One-time, manual provisioning of the e2e bot identities on Dash testnet or on
 * a devnet (`NETWORK=devnet`, see scripts/sdk-env.mjs).
 *
 * Identity keys are derived deterministically from `E2E_SEED_PHRASE`
 * (see scripts/derive-identities.mjs). The asset-lock keypair funding each
 * registration is a random one-shot: only the resulting proof matters, and the
 * identity ID comes from the asset-lock outpoint — which is why the IDs are
 * recorded in `.env.testing` / `.env.devnet` rather than derived.
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
 *   node scripts/provision-test-identity.mjs --gen-asset-lock-key <keyfile>   # prints the pubkey/address to fund
 *   # POST /api/asset-lock-proof elsewhere, save the JSON response, then:
 *   node scripts/provision-test-identity.mjs <index> --asset-lock-key-file <keyfile> --funding-proof-file <json>
 *
 * DEVNET (`NETWORK=devnet`) differs in two ways that matter:
 *
 *  1. InstantSend asset-lock proofs are REFUSED. On the moutai build, rs-dapi's
 *     bloom matcher never forwards the IS lock, so an InstantSend-funded lock
 *     silently burns the funds (dashpay/platform#4399). Only ChainLock proofs are
 *     built here.
 *  2. There is no proof-serving faucet API. Fund the asset-lock address printed by
 *     `--gen-asset-lock-key` from the devnet's own faucet (moutai:
 *     https://faucet.moutai.networks.dash.org/), then hand the resulting outpoint
 *     back with `--funding-outpoint <txid>:<vout>`. The script waits for that
 *     transaction to be buried under a chain lock — Insight for the block height,
 *     DAPI `getStatus().chain.coreChainLockedHeight` for the lock — and only then
 *     builds `AssetLockProof.createChainAssetLockProof`.
 *
 * Every one-shot asset-lock private key is appended to the gitignored
 * `.devnet-locks.local` BEFORE anything is broadcast, so funds are never stranded
 * behind a key that only ever existed in memory.
 *
 * Never prints the mnemonic or any WIF.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPublicKey, utils as secpUtils } from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58check from 'bs58check';
import {
  AssetLockProof,
  Identity,
  IdentityPublicKey,
  IdentitySigner,
  OutPoint,
  PrivateKey,
} from '@dashevo/evo-sdk';
import { CRITICAL_AUTH_KEY_ID, REPO_ROOT, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { connectSdk, insightUrl, keyNetwork, network } from './sdk-env.mjs';

// ---- Config -----------------------------------------------------------------
const FAUCET_URL = 'https://faucet.thepasta.org';
const MIN_BALANCE_CREDITS = 100000000n; // below this, the identity can't reliably finish a write suite
const SDK_TIMEOUT_MS = 30000;
/** How long to wait for a devnet funding tx to be buried under a chain lock. */
const CHAIN_LOCK_TIMEOUT_MS = 600000;
const CHAIN_LOCK_POLL_MS = 10000;
/** Dash testnet P2PKH version byte; devnets reuse it (moutai Insight reports "testnet"). */
const P2PKH_VERSION = { testnet: 0x8c, mainnet: 0x4c };
/** Gitignored ledger of one-shot asset-lock keys, written before any broadcast. */
const LOCKS_FILE = join(REPO_ROOT, '.devnet-locks.local');
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
    chainLockHeight: null, fundingOutPoint: null,
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
      case '--funding-outpoint': args.fundingOutPoint = parseOutPoint(argv[++i]); break;
      case '--chain-lock': args.chainLockHeight = Number(argv[++i]); break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        args.positional.push(arg);
    }
  }

  if (args.fundingProofFile && args.fundingOutPoint) {
    throw new Error('--funding-proof-file and --funding-outpoint are alternatives, not both');
  }
  const hasFunding = Boolean(args.fundingProofFile) || Boolean(args.fundingOutPoint);
  if (Boolean(args.assetLockKeyFile) !== hasFunding) {
    throw new Error('--asset-lock-key-file must be paired with --funding-proof-file or --funding-outpoint');
  }
  if (network() === 'devnet' && !args.checkBalances && !args.genAssetLockKey && !args.fundingOutPoint) {
    throw new Error(
      'On devnet, fund the asset-lock address yourself and pass --funding-outpoint <txid>:<vout>.\n' +
      '  The proof-serving faucet API is testnet-only, and an InstantSend-funded lock silently burns funds on devnet.'
    );
  }
  if (args.checkBalances || args.topUp || args.genAssetLockKey) return args;

  args.identityIndex = Number(args.positional[0]);
  if (args.positional.length !== 1 || !Number.isInteger(args.identityIndex) || args.identityIndex < 0) {
    throw new Error('Expected a non-negative identity index, --topup <identityId>, or --check-balances');
  }
  return args;
}

/** `txid:vout`, the form a block explorer or wallet reports a funding output in. */
function parseOutPoint(value) {
  const match = /^([0-9a-fA-F]{64}):(\d+)$/.exec((value ?? '').trim());
  if (!match) throw new Error(`--funding-outpoint expects <txid>:<vout>, got "${value}"`);
  return { txid: match[1].toLowerCase(), vout: Number(match[2]) };
}

/** P2PKH address for a compressed public key, so a faucet can pay the asset lock. */
function addressFor(publicKeyHex) {
  const hash160 = ripemd160(sha256(Buffer.from(publicKeyHex, 'hex')));
  const payload = new Uint8Array(21);
  payload[0] = P2PKH_VERSION[keyNetwork()];
  payload.set(hash160, 1);
  return bs58check.encode(payload);
}

/** Random one-shot secp256k1 keypair that will control the asset-lock output. */
function generateAssetLockKeypair() {
  const privateKeyBytes = secpUtils.randomSecretKey();
  const publicKeyHex = Buffer.from(getPublicKey(privateKeyBytes, true)).toString('hex');
  return { privateKeyBytes, publicKeyHex };
}

/**
 * Records a one-shot asset-lock key before it is used, so funds sent to it stay
 * recoverable even if the run dies mid-broadcast. The file is gitignored.
 */
function persistAssetLockKey(assetLock, note) {
  const line = [
    new Date().toISOString(),
    network(),
    note,
    addressFor(assetLock.publicKeyHex),
    Buffer.from(assetLock.privateKeyBytes).toString('hex'),
  ].join('\t');
  appendFileSync(LOCKS_FILE, `${line}\n`, { mode: 0o600 });
  console.log(`asset-lock key recorded in ${LOCKS_FILE}`);
}

/**
 * Blocks until the funding transaction is buried under a chain lock.
 *
 * Insight supplies the block height the transaction landed in; DAPI's
 * `getStatus` supplies the highest chain-locked core height. `createChainAssetLockProof`
 * needs the former to be covered by the latter, otherwise Drive rejects the proof.
 */
async function waitForChainLock(sdk, txid) {
  const base = insightUrl();
  const deadline = Date.now() + CHAIN_LOCK_TIMEOUT_MS;
  let txHeight = null;

  while (Date.now() < deadline) {
    if (txHeight === null) {
      try {
        const response = await fetch(`${base}/tx/${txid}`);
        if (response.ok) {
          const tx = await response.json();
          if (typeof tx.blockheight === 'number' && tx.blockheight > 0) {
            txHeight = tx.blockheight;
            console.log(`funding tx mined at core height ${txHeight}`);
          }
        }
      } catch (e) {
        console.warn(`insight lookup failed, retrying: ${e?.message ?? e}`);
      }
    }

    if (txHeight !== null) {
      const status = await sdk.system.status();
      // wasm-sdk's live StatusChain class exposes the snake_case getter
      // (core_chain_locked_height); only the plain toObject()/JSON shape uses
      // camelCase. Reading camelCase off the class silently yields undefined,
      // which is how the 600s wait used to time out forever. Accept both.
      const chain = status?.chain;
      const lockedHeight = Number(chain?.core_chain_locked_height ?? chain?.coreChainLockedHeight ?? 0);
      if (lockedHeight >= txHeight) {
        console.log(`chain-locked: coreChainLockedHeight=${lockedHeight} >= ${txHeight}`);
        return txHeight;
      }
      console.log(`waiting for chain lock: coreChainLockedHeight=${lockedHeight}, need ${txHeight}`);
    } else {
      console.log(`waiting for ${txid} to be mined …`);
    }
    await new Promise((resolve) => setTimeout(resolve, CHAIN_LOCK_POLL_MS));
  }

  throw new Error(
    `Timed out after ${CHAIN_LOCK_TIMEOUT_MS / 1000}s waiting for ${txid} to be chain-locked. ` +
    'The funds are still at the asset-lock address (see .devnet-locks.local) — re-run with the same ' +
    '--asset-lock-key-file and --funding-outpoint once the chain catches up.'
  );
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
    if (network() === 'devnet') {
      // rs-dapi on the devnet build never forwards the InstantSend lock, so the
      // proof is never usable and the funds behind it are lost for good.
      throw new Error('InstantSend asset-lock proofs burn funds on devnet — use --funding-outpoint instead');
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
async function obtainFunding(sdk, args) {
  if (args.fundingOutPoint) {
    // Devnet path: the asset-lock output was funded out of band, so all that is
    // left is to wait for its transaction to be chain-locked and claim the outpoint.
    const assetLock = loadAssetLockKeypair(args.assetLockKeyFile);
    const { txid, vout } = args.fundingOutPoint;
    const height = args.chainLockHeight ?? (await waitForChainLock(sdk, txid));
    console.log(`using chain asset-lock proof: height=${height} outpoint=${txid}:${vout}`);
    return {
      assetLock,
      assetLockProof: AssetLockProof.createChainAssetLockProof(height, new OutPoint(txid, vout)),
    };
  }
  if (args.fundingProofFile) {
    const assetLock = loadAssetLockKeypair(args.assetLockKeyFile);
    const funding = JSON.parse(readFileSync(args.fundingProofFile, 'utf8'));
    if (!funding.assetLockProof) throw new Error(`${args.fundingProofFile} has no assetLockProof field`);
    console.log(`using pre-fetched asset lock proof: txid=${funding.txid} credits=${funding.creditsAmount}`);
    return { assetLock, assetLockProof: assetLockProofFromFaucet(funding.assetLockProof, args.chainLockHeight) };
  }
  const assetLock = generateAssetLockKeypair();
  persistAssetLockKey(assetLock, 'faucet-funded');
  console.log(`requesting asset lock proof from ${FAUCET_URL} …`);
  const funding = await requestAssetLockProof(assetLock.publicKeyHex, args.capToken);
  console.log(`funded: txid=${funding.txid} credits=${funding.creditsAmount}`);
  return { assetLock, assetLockProof: assetLockProofFromFaucet(funding.assetLockProof, args.chainLockHeight) };
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

async function createIdentity(sdk, identityIndex, dpnsLabel, args) {
  const keys = deriveIdentityKeys(identityIndex);
  console.log(`derived ${keys.length} keys for identity index ${identityIndex}`);

  if (dpnsLabel && !(await sdk.dpns.isNameAvailable(dpnsLabel))) {
    throw new Error(`DPNS name "${dpnsLabel}" is already taken — pick another label`);
  }

  const { assetLock, assetLockProof } = await obtainFunding(sdk, args);
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
    assetLockPrivateKey: PrivateKey.fromBytes(assetLock.privateKeyBytes, keyNetwork()),
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
  const envFile = network() === 'devnet' ? '.env.devnet' : '.env.testing';
  console.log(`Append ${identityIdBase58} to E2E_IDENTITY_IDS in ${envFile} (index ${identityIndex} order).`);
}

async function topUp(sdk, identityId, args) {
  const identity = await sdk.identities.fetch(identityId);
  if (!identity) throw new Error(`Identity ${identityId} not found on ${network()}`);

  const { assetLock, assetLockProof } = await obtainFunding(sdk, args);

  const newBalance = await sdk.identities.topUp({
    identity,
    assetLockProof,
    assetLockPrivateKey: PrivateKey.fromBytes(assetLock.privateKeyBytes, keyNetwork()),
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
  console.error('       NETWORK=devnet node scripts/provision-test-identity.mjs <index> --asset-lock-key-file <keyfile> --funding-outpoint <txid>:<vout>');
  process.exit(1);
}

if (args.genAssetLockKey) {
  const assetLock = generateAssetLockKeypair();
  writeFileSync(args.genAssetLockKey, `${Buffer.from(assetLock.privateKeyBytes).toString('hex')}\n`, { mode: 0o600 });
  persistAssetLockKey(assetLock, `gen:${args.genAssetLockKey}`);
  console.log(`asset-lock private key written to ${args.genAssetLockKey} (mode 600)`);
  console.log(`assetLockPublicKey: ${assetLock.publicKeyHex}`);
  console.log(`assetLockAddress:   ${addressFor(assetLock.publicKeyHex)}`);
  process.exit(0);
}

try {
  const sdk = await connectSdk({ timeoutMs: SDK_TIMEOUT_MS });
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
