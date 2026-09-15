/**
 * Treasury-funded BULK identity provisioning for devnet content seeding.
 *
 * Turns a personas file (see CORPUS_FORMAT.md) into funded, registered,
 * profiled, DPNS-named, YAPP-holding devnet identities, driven by a per-identity
 * state machine persisted in the gitignored ledger `.seed-identities.local.json`
 * (chmod 600). Every private key is written to the ledger BEFORE the broadcast
 * that depends on it — the same discipline provision-test-identity.mjs uses —
 * so no funds are ever stranded behind key material that existed only in memory.
 *
 * Phases (each identity advances independently; re-running skips what's done;
 * --parallel N runs the per-identity phases REGISTER/PROFILE/DPNS/YAPP-purchase
 * N identities at a time — maker YAPP transfers stay serial):
 *   SPLIT     one core-chain tx spends treasury UTXO(s) into one P2PKH output
 *             per identity (default 8,000,000 duffs, --credits-per overrides),
 *             each paying a fresh one-shot asset-lock key; change → treasury
 *   LOCK      per identity, a DIP-2 type-8 asset-lock special tx spends its
 *             funding output (proof outpoint = txid:0)
 *   REGISTER  wait for ChainLock coverage (Insight height + DAPI getStatus —
 *             InstantSend proofs are REFUSED on moutai), then create the
 *             identity with 5 fresh random keys (same purpose/security-level
 *             set as the e2e bots)
 *   PROFILE   create the persona's profile document on the unified profile
 *             contract (validated against its maxLengths)
 *   DPNS      register the persona's handle
 *   YAPP      fund each identity with YAPP (the v4 social contract charges
 *             YAPP per post/reply/like create). Two sources:
 *               --yapp-source purchase  direct purchase with the identity's own
 *                                       credits — requires the token's
 *                                       direct-purchase price to be set on THIS
 *                                       contract (scripts/set-yapp-price.mjs
 *                                       --contract <id> --owner <makerId>
 *                                       --owner-index 9). As of 2026-08-30 the
 *                                       v4 draft (Aux325if…) has NO price set.
 *               --yapp-source maker     (default) token transfer from the
 *                                       devnet maker (seed index 9, keys from
 *                                       E2E_SEED_PHRASE, id from
 *                                       DEVNET_MAKER_IDENTITY_ID in .env.devnet)
 *
 * Setup: put a 64-hex private key in `.seed-treasury.local.key` (chmod 600) and
 * send devnet DASH to its address (printed by --treasury-address) from the
 * moutai faucet: https://faucet.moutai.networks.dash.org/
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/provision-seed-identities.mjs --personas <file> \
 *     [--credits-per <duffs>] [--yapp <tokens>] [--only <idx,idx>]
 *   node scripts/seed/provision-seed-identities.mjs --self-test
 *   NETWORK=devnet node scripts/seed/provision-seed-identities.mjs --treasury-address
 *
 * Never prints private keys or WIFs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  AssetLockProof,
  Identity,
  IdentityPublicKey,
  IdentitySigner,
  OutPoint,
  PrivateKey,
  ensureInitialized,
} from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import {
  CRITICAL_AUTH_KEY_ID,
  DUPLICATE_UNIQUE,
  LEDGER_FILE,
  TREASURY_KEY_FILE,
  TRANSPORT_COLLAPSE,
  WAIT_MAYBE_LANDED,
  YAPP_TOKEN_POSITION,
  addressFor,
  avatarFieldFor,
  buildDocument,
  createSdkHandle,
  describeErr,
  generateIdentityKeySet,
  generateKeypairHex,
  ledgerEntry,
  loadLedger,
  loadPersonas,
  network,
  paymentInfo,
  profileContractId,
  profileLimits,
  randomEntropy,
  readback,
  saveLedger,
  sleep,
  socialContractId,
  stateRank,
  validateHandle,
  validatePersona,
  wifFromHex,
} from './seed-lib.mjs';
import {
  ASSET_LOCK_FEE_DUFFS,
  addressOfPrivateKeyHex,
  broadcastTx,
  buildAssetLockTx,
  buildSplitTx,
  fakeUtxoFor,
  fetchTx,
  fetchUtxos,
} from './asset-lock-lib.mjs';

const DEFAULT_CREDITS_PER_DUFFS = 8_000_000;
const DEFAULT_YAPP_PER_IDENTITY = 600n;
/** YAPP direct purchase enforces a minimum amount (set-yapp-price.mjs: 100). */
const MIN_YAPP_PURCHASE = 100n;
const CHAIN_LOCK_TIMEOUT_MS = 600_000;
const CHAIN_LOCK_POLL_MS = 10_000;
const SDK_TIMEOUT_MS = 30_000;

// ---- CLI ------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    personas: null,
    creditsPer: DEFAULT_CREDITS_PER_DUFFS,
    yapp: DEFAULT_YAPP_PER_IDENTITY,
    yappSource: 'maker',
    only: null,
    selfTest: false,
    treasuryAddress: false,
    parallel: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--personas': args.personas = argv[++i]; break;
      case '--credits-per': args.creditsPer = Number(argv[++i]); break;
      case '--yapp': args.yapp = BigInt(argv[++i]); break;
      case '--yapp-source': args.yappSource = argv[++i]; break;
      case '--only': args.only = new Set(argv[++i].split(',').map((s) => Number(s.trim()))); break;
      case '--self-test': args.selfTest = true; break;
      case '--treasury-address': args.treasuryAddress = true; break;
      case '--parallel': args.parallel = Number(argv[++i]); break;
      default: throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (!['maker', 'purchase'].includes(args.yappSource)) {
    throw new Error('--yapp-source must be "maker" (token transfer from seed index 9) or "purchase" (direct purchase)');
  }
  if (!args.selfTest && !args.treasuryAddress && !args.personas) {
    throw new Error('--personas <file> is required (or --self-test / --treasury-address)');
  }
  if (!Number.isInteger(args.creditsPer) || args.creditsPer < 1_000_000) {
    throw new Error('--credits-per must be an integer ≥ 1,000,000 duffs (identity registration alone eats a chunk)');
  }
  if (args.yapp < 0n) throw new Error('--yapp must be ≥ 0 (0 skips the purchase phase)');
  if (!Number.isInteger(args.parallel) || args.parallel < 1 || args.parallel > 64) {
    throw new Error('--parallel must be an integer between 1 and 64');
  }
  return args;
}

function loadTreasuryKeyHex() {
  if (!existsSync(TREASURY_KEY_FILE)) {
    throw new Error(
      `${TREASURY_KEY_FILE} not found. Create it (chmod 600) with a 64-hex private key and fund its ` +
      'address from the devnet faucet — see scripts/seed/README.md.'
    );
  }
  const hex = readFileSync(TREASURY_KEY_FILE, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${TREASURY_KEY_FILE} is not a 64-hex private key`);
  return hex;
}

// ---- Ledger sync ------------------------------------------------------------------

/**
 * Ensures every selected persona has a ledger entry with its one-shot
 * asset-lock key and full identity key set generated and PERSISTED before
 * anything is broadcast.
 */
function syncLedger(ledger, personas, only) {
  let dirty = false;
  for (const persona of personas) {
    if (only && !only.has(persona.idx)) continue;
    let entry = ledgerEntry(ledger, persona.idx);
    if (!entry) {
      const assetLock = generateKeypairHex();
      entry = {
        personaIdx: persona.idx,
        handle: persona.handle,
        state: 'planned',
        assetLockKeyHex: assetLock.privateKeyHex,
        assetLockAddress: addressFor(assetLock.publicKeyHex),
        identityKeys: generateIdentityKeySet(),
        errors: [],
      };
      ledger.identities.push(entry);
      dirty = true;
    } else if (entry.handle !== persona.handle) {
      throw new Error(
        `ledger persona ${persona.idx} was planned with handle "${entry.handle}" but the personas file now says ` +
        `"${persona.handle}" — refusing to guess (fix the personas file or start a new ledger)`
      );
    }
  }
  if (dirty) saveLedger(ledger);
  return ledger;
}

function selected(ledger, only) {
  return ledger.identities.filter((entry) => !only || only.has(entry.personaIdx));
}

/**
 * Run `fn(entry)` over `entries` with at most `limit` in flight. Each entry is
 * an independent identity (own keys, own nonce), so the REGISTER / PROFILE /
 * DPNS / YAPP-purchase phases parallelise safely; `fn` must catch its own
 * errors (every phase already routes failures through noteError).
 */
async function forEachParallel(entries, limit, fn) {
  const queue = entries.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) await fn(queue.shift());
  });
  await Promise.all(workers);
}

function noteError(ledger, entry, phase, error) {
  const message = describeErr(error).slice(0, 500);
  entry.errors.push({ phase, at: new Date().toISOString(), message });
  saveLedger(ledger);
  console.error(`  persona ${entry.personaIdx} (${entry.handle}) ${phase} FAILED: ${message.slice(0, 220)}`);
}

// ---- Phase SPLIT -------------------------------------------------------------------

/**
 * One transaction funds every identity still in `planned`. A previously
 * recorded-but-unconfirmed funding outpoint is probed on Insight first: if the
 * tx exists the identity advances instead of being double-paid.
 */
async function phaseSplit(ledger, only, creditsPer) {
  const pending = [];
  for (const entry of selected(ledger, only)) {
    if (stateRank(entry.state) > stateRank('planned')) continue;
    if (entry.fundingOutpoint) {
      const tx = await fetchTx(entry.fundingOutpoint.txid);
      if (tx) {
        entry.state = 'funded';
        saveLedger(ledger);
        console.log(`  persona ${entry.personaIdx}: funding tx already on chain (${entry.fundingOutpoint.txid.slice(0, 16)}…)`);
        continue;
      }
      console.log(`  persona ${entry.personaIdx}: stale planned funding tx never landed — refunding`);
      delete entry.fundingOutpoint;
    }
    pending.push(entry);
  }
  if (pending.length === 0) {
    console.log('  nothing to fund');
    return;
  }

  const treasuryKeyHex = loadTreasuryKeyHex();
  const treasuryAddress = addressOfPrivateKeyHex(treasuryKeyHex);
  const utxos = await fetchUtxos(treasuryAddress);
  const recipients = pending.map((entry) => ({ address: entry.assetLockAddress, duffs: creditsPer }));
  const split = buildSplitTx({ treasuryPrivateKeyHex: treasuryKeyHex, utxos, recipients });

  // Ledger first: the outpoints (and the one-shot keys, already saved) must
  // survive a crash between here and the broadcast.
  pending.forEach((entry, i) => {
    entry.fundingOutpoint = { txid: split.txid, vout: split.recipientVouts[i], duffs: creditsPer };
  });
  saveLedger(ledger);

  console.log(`  split tx ${split.txid}: ${pending.length} × ${creditsPer} duffs, fee=${split.fee}, change=${split.changeDuffs} (${split.inputsUsed} input(s))`);
  await broadcastTx(split.rawtx);
  for (const entry of pending) entry.state = 'funded';
  saveLedger(ledger);
  console.log('  split broadcast ok');
}

// ---- Phase LOCK --------------------------------------------------------------------

async function phaseLock(ledger, only) {
  for (const entry of selected(ledger, only)) {
    if (stateRank(entry.state) !== stateRank('funded')) continue;
    try {
      if (entry.lockOutpoint) {
        const tx = await fetchTx(entry.lockOutpoint.txid);
        if (tx) {
          entry.state = 'locked';
          saveLedger(ledger);
          console.log(`  persona ${entry.personaIdx}: asset lock already on chain (${entry.lockOutpoint.txid.slice(0, 16)}…)`);
          continue;
        }
        console.log(`  persona ${entry.personaIdx}: stale planned asset lock never landed — rebuilding`);
        delete entry.lockOutpoint;
      }
      // The split tx may still be propagating; give Insight a bounded moment.
      let utxo = null;
      for (let attempt = 0; attempt < 9 && !utxo; attempt++) {
        if (attempt > 0) await sleep(10_000);
        const utxos = await fetchUtxos(entry.assetLockAddress);
        utxo = utxos.find(
          (u) => u.txid === entry.fundingOutpoint.txid && u.vout === entry.fundingOutpoint.vout
        ) ?? null;
      }
      if (!utxo) {
        throw new Error(
          `funding outpoint ${entry.fundingOutpoint.txid}:${entry.fundingOutpoint.vout} not among the UTXOs of ` +
          `${entry.assetLockAddress} after 80s — is the split tx confirmed yet? Re-run to resume.`
        );
      }
      const lock = buildAssetLockTx({ privateKeyHex: entry.assetLockKeyHex, utxo });
      entry.lockOutpoint = { ...lock.outpoint, creditDuffs: lock.creditDuffs };
      saveLedger(ledger); // outpoint recorded BEFORE broadcast
      await broadcastTx(lock.rawtx);
      entry.state = 'locked';
      saveLedger(ledger);
      console.log(`  persona ${entry.personaIdx}: asset lock ${lock.txid.slice(0, 16)}… (${lock.creditDuffs} duffs locked)`);
    } catch (e) {
      noteError(ledger, entry, 'lock', e);
    }
  }
}

// ---- ChainLock wait -----------------------------------------------------------------

/**
 * Waits until every given lock txid is buried under a chain lock: Insight
 * supplies each transaction's block height, DAPI getStatus the highest
 * chain-locked core height (snake_case getter on the live class — camelCase
 * silently yields undefined). All transactions wait in one shared poll loop.
 */
async function waitForChainLocks(sdk, txids) {
  const heights = new Map();
  const deadline = Date.now() + CHAIN_LOCK_TIMEOUT_MS;
  const remaining = new Set(txids);
  let lockedHeight = 0;
  while (remaining.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${CHAIN_LOCK_TIMEOUT_MS / 1000}s waiting for chain locks over ${[...remaining].join(', ')} — ` +
        're-run to resume (funds are safe behind the ledger keys)'
      );
    }
    for (const txid of remaining) {
      if (heights.has(txid)) continue;
      try {
        const tx = await fetchTx(txid);
        if (tx && typeof tx.blockheight === 'number' && tx.blockheight > 0) {
          heights.set(txid, tx.blockheight);
          console.log(`  ${txid.slice(0, 16)}… mined at core height ${tx.blockheight}`);
        }
      } catch (e) {
        console.warn(`  insight lookup failed, retrying: ${e?.message ?? e}`);
      }
    }
    try {
      const status = await sdk.system.status();
      const chain = status?.chain;
      lockedHeight = Number(chain?.core_chain_locked_height ?? chain?.coreChainLockedHeight ?? 0);
    } catch (e) {
      console.warn(`  getStatus failed, retrying: ${describeErr(e).slice(0, 120)}`);
    }
    for (const txid of [...remaining]) {
      const height = heights.get(txid);
      if (height !== undefined && lockedHeight >= height) {
        remaining.delete(txid);
        console.log(`  ${txid.slice(0, 16)}… chain-locked (${lockedHeight} >= ${height})`);
      }
    }
    if (remaining.size > 0) {
      console.log(`  waiting for chain lock: coreChainLockedHeight=${lockedHeight}, ${remaining.size} tx(s) pending`);
      await sleep(CHAIN_LOCK_POLL_MS);
    }
  }
  return heights;
}

// ---- Phase REGISTER -----------------------------------------------------------------

function buildSignerFor(entry) {
  const signer = new IdentitySigner();
  for (const key of entry.identityKeys) signer.addKeyFromWif(wifFromHex(key.privateKeyHex));
  return signer;
}

async function phaseRegister(handle, ledger, only, parallel) {
  const sdk = handle.sdk;
  const toRegister = selected(ledger, only).filter((entry) => stateRank(entry.state) === stateRank('locked'));
  if (toRegister.length === 0) {
    console.log('  nothing to register');
    return;
  }
  const heights = await waitForChainLocks(sdk, toRegister.map((entry) => entry.lockOutpoint.txid));

  await forEachParallel(toRegister, parallel, async (entry) => {
    try {
      const proof = AssetLockProof.createChainAssetLockProof(
        heights.get(entry.lockOutpoint.txid),
        new OutPoint(entry.lockOutpoint.txid, entry.lockOutpoint.vout ?? 0)
      );
      const identityId = proof.createIdentityId();
      const identityIdBase58 = identityId.toBase58();
      entry.identityId = identityIdBase58;
      saveLedger(ledger);

      // Idempotency: a previous run's create may have landed before it crashed.
      const existing = await readback(handle, () => sdk.identities.fetch(identityIdBase58));
      if (existing) {
        entry.state = 'registered';
        saveLedger(ledger);
        console.log(`  persona ${entry.personaIdx}: identity ${identityIdBase58} already exists — skipping create`);
        return;
      }

      const identity = new Identity(identityId);
      const signer = new IdentitySigner();
      for (const key of entry.identityKeys) {
        identity.addPublicKey(new IdentityPublicKey({
          keyId: key.keyId,
          purpose: key.purpose,
          securityLevel: key.securityLevel,
          keyType: 'ecdsa_secp256k1',
          isReadOnly: false,
          data: Uint8Array.from(Buffer.from(key.publicKeyHex, 'hex')),
        }));
        signer.addKeyFromWif(wifFromHex(key.privateKeyHex));
      }

      console.log(`  persona ${entry.personaIdx}: registering identity ${identityIdBase58} …`);
      try {
        await sdk.identities.create({
          identity,
          assetLockProof: proof,
          assetLockPrivateKey: PrivateKey.fromBytes(Uint8Array.from(Buffer.from(entry.assetLockKeyHex, 'hex')), 'testnet'),
          signer,
        });
      } catch (e) {
        // The gateway 504s the confirmation wait routinely; the chain decides.
        const text = describeErr(e);
        if (!WAIT_MAYBE_LANDED.test(text) && !TRANSPORT_COLLAPSE.test(text)) throw e;
        if (TRANSPORT_COLLAPSE.test(text)) await handle.reconnect(text);
        await sleep(3000);
        const landed = await readback(handle, () => sdk.identities.fetch(identityIdBase58));
        if (!landed) throw e;
      }
      entry.state = 'registered';
      saveLedger(ledger);
      const balance = await readback(handle, () => sdk.identities.balance(identityIdBase58));
      console.log(`  persona ${entry.personaIdx}: registered, balance=${balance} credits`);
    } catch (e) {
      noteError(ledger, entry, 'register', e);
    }
  });
}

// ---- Phase PROFILE ------------------------------------------------------------------

async function phaseProfile(handle, ledger, only, personasByIdx, parallel) {
  const sdk = handle.sdk;
  const contractId = profileContractId();
  const todo = selected(ledger, only).filter((entry) => stateRank(entry.state) === stateRank('registered'));
  await forEachParallel(todo, parallel, async (entry) => {
    try {
      const persona = personasByIdx.get(entry.personaIdx);
      if (!persona) throw new Error(`persona ${entry.personaIdx} missing from the personas file`);

      const existing = await readback(handle, () =>
        sdk.documents.query({
          dataContractId: contractId,
          documentTypeName: 'profile',
          where: [['$ownerId', '==', entry.identityId]],
        })
      );
      if (existing.size > 0) {
        entry.state = 'profiled';
        saveLedger(ledger);
        console.log(`  persona ${entry.personaIdx}: profile already exists`);
        return;
      }

      const identity = await readback(handle, () => sdk.identities.fetch(entry.identityId));
      if (!identity) throw new Error(`identity ${entry.identityId} not readable`);
      const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
      const signer = buildSignerFor(entry);
      const { document, id } = buildDocument({
        contractId,
        docType: 'profile',
        ownerId: entry.identityId,
        entropy: randomEntropy(),
        data: {
          displayName: persona.displayName,
          ...(persona.bio ? { bio: persona.bio } : {}),
          ...(persona.location ? { location: persona.location } : {}),
          ...(persona.website ? { website: persona.website } : {}),
          avatar: avatarFieldFor(persona),
        },
      });
      try {
        await sdk.documents.create({ document, identityKey, signer });
      } catch (e) {
        const text = describeErr(e);
        if (DUPLICATE_UNIQUE.test(text)) {
          // unique-by-$ownerId — someone (a previous run) got there first
        } else if (WAIT_MAYBE_LANDED.test(text) || TRANSPORT_COLLAPSE.test(text)) {
          if (TRANSPORT_COLLAPSE.test(text)) await handle.reconnect(text);
          await sleep(3000);
          const landed = await readback(handle, () => sdk.documents.get(contractId, 'profile', id));
          if (!landed) throw e;
        } else {
          throw e;
        }
      }
      entry.state = 'profiled';
      saveLedger(ledger);
      console.log(`  persona ${entry.personaIdx}: profile created ("${persona.displayName}")`);
    } catch (e) {
      noteError(ledger, entry, 'profile', e);
    }
  });
}

// ---- Phase DPNS ---------------------------------------------------------------------

async function phaseDpns(handle, ledger, only, parallel) {
  const sdk = handle.sdk;
  const todo = selected(ledger, only).filter((entry) => stateRank(entry.state) === stateRank('profiled'));
  await forEachParallel(todo, parallel, async (entry) => {
    try {
      const existingName = await readback(handle, () => sdk.dpns.username(entry.identityId));
      if (existingName && existingName.toLowerCase().startsWith(`${entry.handle}.`)) {
        entry.state = 'named';
        saveLedger(ledger);
        console.log(`  persona ${entry.personaIdx}: DPNS name already registered (${existingName})`);
        return;
      }
      if (!(await readback(handle, () => sdk.dpns.isNameAvailable(entry.handle)))) {
        throw new Error(`DPNS name "${entry.handle}" is taken by another identity — change the persona handle`);
      }
      const identity = await readback(handle, () => sdk.identities.fetch(entry.identityId));
      if (!identity) throw new Error(`identity ${entry.identityId} not readable`);
      const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
      const signer = buildSignerFor(entry);
      console.log(`  persona ${entry.personaIdx}: registering DPNS "${entry.handle}" …`);
      try {
        await sdk.dpns.registerName({ label: entry.handle, identity, identityKey, signer });
      } catch (e) {
        const text = describeErr(e);
        if (!WAIT_MAYBE_LANDED.test(text) && !TRANSPORT_COLLAPSE.test(text)) throw e;
        if (TRANSPORT_COLLAPSE.test(text)) await handle.reconnect(text);
        await sleep(3000);
        const nowNamed = await readback(handle, () => sdk.dpns.username(entry.identityId));
        if (!nowNamed || !nowNamed.toLowerCase().startsWith(`${entry.handle}.`)) throw e;
      }
      entry.state = 'named';
      saveLedger(ledger);
      console.log(`  persona ${entry.personaIdx}: DPNS name registered (${entry.handle}.dash)`);
    } catch (e) {
      noteError(ledger, entry, 'dpns', e);
    }
  });
}

// ---- Phase YAPP ---------------------------------------------------------------------

/** The devnet maker (contract owner, seed index 9): holds the YAPP base supply. */
async function makerContext(handle) {
  const { deriveIdentityKeys, criticalAuthKey, readEnvFile: readEnv, REPO_ROOT: root } = await import('../derive-identities.mjs');
  const { join } = await import('node:path');
  const makerId = process.env.DEVNET_MAKER_IDENTITY_ID
    ?? readEnv(join(root, '.env.devnet')).DEVNET_MAKER_IDENTITY_ID;
  if (!makerId) throw new Error('DEVNET_MAKER_IDENTITY_ID missing from the environment and .env.devnet');
  const { wif } = criticalAuthKey(deriveIdentityKeys(9)); // needs E2E_SEED_PHRASE (env or .env.local)
  const identity = await readback(handle, () => handle.sdk.identities.fetch(makerId));
  if (!identity) throw new Error(`maker identity ${makerId} not found on this devnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wif);
  return { makerId, identityKey, signer };
}

async function phaseYapp(handle, ledger, only, yappTarget, yappSource, parallel) {
  const sdk = handle.sdk;
  const contractId = socialContractId();
  const tokenId = await readback(handle, () => sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION));

  // Lazy: neither the maker keys nor the price are touched unless an identity
  // actually needs funding (so a fully-provisioned re-run needs no seed phrase).
  let pricePromise = null;
  const getPrice = () => (pricePromise ??= (async () => {
    const prices = await readback(handle, () => sdk.tokens.directPurchasePrices([tokenId]));
    const priceInfo = prices instanceof Map ? prices.get(tokenId) : prices?.[tokenId];
    const pricePerToken = priceInfo?.currentPrice !== undefined ? BigInt(priceInfo.currentPrice) : null;
    if (pricePerToken === null) {
      throw new Error(
        `YAPP token ${tokenId} has no direct-purchase price on contract ${contractId}. Either set one\n` +
        `  (NETWORK=devnet node scripts/set-yapp-price.mjs --contract ${contractId} --owner <makerId> --owner-index 9)\n` +
        '  or re-run with --yapp-source maker.'
      );
    }
    return pricePerToken;
  })());
  let makerPromise = null;
  const getMaker = () => (makerPromise ??= makerContext(handle));

  // Maker transfers all spend ONE identity's nonce sequence and the SDK waits
  // per call, so they stay serial; direct purchases are per-identity and parallelise.
  const todo = selected(ledger, only).filter((entry) => stateRank(entry.state) === stateRank('named'));
  const limit = yappSource === 'maker' ? 1 : parallel;
  await forEachParallel(todo, limit, async (entry) => {
    try {
      if (yappTarget === 0n) {
        entry.state = 'ready';
        saveLedger(ledger);
        return;
      }
      const balances = await readback(handle, () => sdk.tokens.balances([entry.identityId], tokenId));
      const balance = (balances instanceof Map ? balances.get(entry.identityId) : undefined) ?? 0n;
      if (balance >= yappTarget) {
        entry.state = 'ready';
        saveLedger(ledger);
        console.log(`  persona ${entry.personaIdx}: already holds ${balance} YAPP`);
        return;
      }
      let amount = yappTarget - balance;

      const settledOk = async () => {
        await sleep(3000);
        const after = await readback(handle, () => sdk.tokens.balances([entry.identityId], tokenId));
        return ((after instanceof Map ? after.get(entry.identityId) : undefined) ?? 0n) >= yappTarget;
      };

      if (yappSource === 'maker') {
        const maker = await getMaker();
        console.log(`  persona ${entry.personaIdx}: transferring ${amount} YAPP from the maker …`);
        try {
          await sdk.tokens.transfer({
            dataContractId: contractId,
            tokenPosition: YAPP_TOKEN_POSITION,
            amount,
            senderId: maker.makerId,
            recipientId: entry.identityId,
            identityKey: maker.identityKey,
            signer: maker.signer,
          });
        } catch (e) {
          const text = describeErr(e);
          if (!WAIT_MAYBE_LANDED.test(text) && !TRANSPORT_COLLAPSE.test(text)) throw e;
          if (TRANSPORT_COLLAPSE.test(text)) await handle.reconnect(text);
          if (!(await settledOk())) throw e;
        }
      } else {
        const pricePerToken = await getPrice();
        if (amount < MIN_YAPP_PURCHASE) amount = MIN_YAPP_PURCHASE; // SetPrices lowest tier
        const identity = await readback(handle, () => sdk.identities.fetch(entry.identityId));
        const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID); // direct purchase requires CRITICAL
        const signer = buildSignerFor(entry);
        console.log(`  persona ${entry.personaIdx}: buying ${amount} YAPP (${amount * pricePerToken} credits) …`);
        try {
          await sdk.tokens.directPurchase({
            dataContractId: contractId,
            tokenPosition: YAPP_TOKEN_POSITION,
            buyerId: entry.identityId,
            amount,
            maxTotalCost: amount * pricePerToken,
            identityKey,
            signer,
          });
        } catch (e) {
          const text = describeErr(e);
          if (!WAIT_MAYBE_LANDED.test(text) && !TRANSPORT_COLLAPSE.test(text)) throw e;
          if (TRANSPORT_COLLAPSE.test(text)) await handle.reconnect(text);
          if (!(await settledOk())) throw e;
        }
      }
      entry.state = 'ready';
      saveLedger(ledger);
      console.log(`  persona ${entry.personaIdx}: YAPP funded`);
    } catch (e) {
      noteError(ledger, entry, 'yapp', e);
    }
  });
}

// ---- Final table ---------------------------------------------------------------------

async function printTable(handle, ledger, only) {
  const sdk = handle.sdk;
  const tokenId = await readback(handle, () => sdk.tokens.calculateId(socialContractId(), YAPP_TOKEN_POSITION));
  console.log('\npersonaIdx  state       handle              identityId                                     credits          YAPP');
  for (const entry of selected(ledger, only)) {
    let credits = '-';
    let yapp = '-';
    if (entry.identityId) {
      try {
        credits = String(await readback(handle, () => sdk.identities.balance(entry.identityId)) ?? 0n);
        const balances = await readback(handle, () => sdk.tokens.balances([entry.identityId], tokenId));
        yapp = String((balances instanceof Map ? balances.get(entry.identityId) : undefined) ?? 0n);
      } catch (e) {
        credits = `? (${describeErr(e).slice(0, 40)})`;
      }
    }
    console.log(
      `${String(entry.personaIdx).padEnd(10)}  ${entry.state.padEnd(10)}  ${entry.handle.padEnd(18)}  ` +
      `${(entry.identityId ?? '-').padEnd(45)}  ${credits.padStart(15)}  ${yapp.padStart(8)}`
    );
  }
}

// ---- Self-test (pure, no network, no broadcast) ---------------------------------------

function selfTest() {
  let failures = 0;
  const check = (name, condition, detail = '') => {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
  };

  // Handle validation
  check('handle: valid', validateHandle('alice42') === null);
  check('handle: needs a 2-9 digit', validateHandle('alice') !== null);
  check('handle: 0/1 alone not enough', validateHandle('alice01') !== null);
  check('handle: no leading hyphen', validateHandle('-alice42') !== null);
  check('handle: no uppercase', validateHandle('Alice42') !== null);
  check('handle: length caps at 19', validateHandle('a2345678901234567890') !== null);

  // Persona validation against the real contract limits
  const limits = profileLimits();
  const persona = { idx: 0, handle: 'alice42', displayName: 'Alice', bio: 'hi', avatarSeed: 'alice-seed' };
  check('persona: valid persona passes', validatePersona(persona, limits).length === 0);
  check('persona: displayName over 50 fails', validatePersona({ ...persona, displayName: 'x'.repeat(51) }, limits).length > 0);
  check('persona: bad website fails', validatePersona({ ...persona, website: 'ftp://x' }, limits).length > 0);
  check('persona: avatar JSON is stable', avatarFieldFor(persona) === avatarFieldFor(persona));

  // Split tx construction with fabricated UTXOs (nothing broadcast)
  const treasury = generateKeypairHex();
  const recipients = Array.from({ length: 10 }, () => ({
    address: addressFor(generateKeypairHex().publicKeyHex),
    duffs: DEFAULT_CREDITS_PER_DUFFS,
  }));
  const utxo = fakeUtxoFor(treasury.privateKeyHex, 100_000_000);
  const split = buildSplitTx({ treasuryPrivateKeyHex: treasury.privateKeyHex, utxos: [utxo], recipients });
  check('split: pays every recipient', split.tx.outputs.length === recipients.length + 1, `${split.tx.outputs.length} outputs`);
  check('split: recipient amounts exact', recipients.every((r, i) => split.tx.outputs[i].satoshis === r.duffs));
  check('split: fee stays in the ~1000/kB class', split.fee > 0 && split.fee < 5_000, `fee=${split.fee}`);
  check(
    'split: value conserved',
    split.tx.outputs.reduce((sum, o) => sum + o.satoshis, 0) + split.fee === utxo.satoshis,
    `change=${split.changeDuffs}`
  );
  let threw = false;
  try {
    buildSplitTx({
      treasuryPrivateKeyHex: treasury.privateKeyHex,
      utxos: [fakeUtxoFor(treasury.privateKeyHex, 1_000_000)],
      recipients,
    });
  } catch {
    threw = true;
  }
  check('split: insufficient treasury balance throws', threw);

  // Asset-lock special tx construction with a fabricated UTXO
  const oneShot = generateKeypairHex();
  const lockUtxo = fakeUtxoFor(oneShot.privateKeyHex, DEFAULT_CREDITS_PER_DUFFS, { txid: 'a'.repeat(64) });
  const lock = buildAssetLockTx({ privateKeyHex: oneShot.privateKeyHex, utxo: lockUtxo });
  check('lock: DIP-2 type 8', lock.tx.type === 8, `type=${lock.tx.type}`);
  check('lock: version 3', lock.tx.version === 3, `version=${lock.tx.version}`);
  check('lock: one visible OP_RETURN output', lock.tx.outputs.length === 1 && lock.tx.outputs[0].script.toString().startsWith('OP_RETURN'));
  check('lock: credit = utxo - flat fee', lock.creditDuffs === DEFAULT_CREDITS_PER_DUFFS - ASSET_LOCK_FEE_DUFFS);
  check('lock: proof outpoint is (txid, 0)', lock.outpoint.vout === 0 && lock.outpoint.txid === lock.txid);

  // Ledger state machine ordering
  check('states: strictly ordered', stateRank('planned') < stateRank('funded') && stateRank('named') < stateRank('ready'));

  console.log(failures === 0 ? '\nSELF-TEST PASSED (no network calls, nothing broadcast)' : `\n${failures} SELF-TEST CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- Main -----------------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: NETWORK=devnet node scripts/seed/provision-seed-identities.mjs --personas <file>');
  console.error('         [--credits-per <duffs>] [--yapp <tokens>] [--yapp-source maker|purchase] [--only <idx,idx>]');
  console.error('       node scripts/seed/provision-seed-identities.mjs --self-test | --treasury-address');
  process.exit(1);
}

if (args.selfTest) {
  selfTest();
}

if (args.treasuryAddress) {
  if (!existsSync(TREASURY_KEY_FILE)) {
    const key = generateKeypairHex();
    writeFileSync(TREASURY_KEY_FILE, `${key.privateKeyHex}\n`, { mode: 0o600 });
    console.log(`treasury key generated and written to ${TREASURY_KEY_FILE} (mode 600)`);
  }
  console.log(`treasury address: ${addressOfPrivateKeyHex(loadTreasuryKeyHex())}`);
  console.log('fund it from https://faucet.moutai.networks.dash.org/ — see scripts/seed/README.md for amounts');
  process.exit(0);
}

if (network() !== 'devnet') {
  console.error('This script only provisions devnets. Run with NETWORK=devnet.');
  process.exit(1);
}

try {
  await ensureInitialized();
  const personas = loadPersonas(args.personas);
  const personasByIdx = new Map(personas.map((p) => [p.idx, p]));
  if (args.only) {
    const unknown = [...args.only].filter((idx) => !personasByIdx.has(idx));
    if (unknown.length > 0) throw new Error(`--only lists unknown persona idx: ${unknown.join(', ')}`);
  }
  const ledger = syncLedger(loadLedger(), personas, args.only);
  console.log(`ledger: ${LEDGER_FILE} (${ledger.identities.length} identities tracked)`);

  console.log('\nPhase SPLIT');
  await phaseSplit(ledger, args.only, args.creditsPer);

  console.log('\nPhase LOCK');
  await phaseLock(ledger, args.only);

  console.log('\nConnecting SDK');
  const handle = createSdkHandle({
    contractIds: [socialContractId(), profileContractId()],
    timeoutMs: SDK_TIMEOUT_MS,
    log: (msg) => console.log(`  ${msg}`),
  });
  const { protocolVersion } = await handle.connect();
  console.log(`  connected (PV${protocolVersion ?? '?'})`);

  console.log('\nPhase REGISTER');
  await phaseRegister(handle, ledger, args.only, args.parallel);

  console.log('\nPhase PROFILE');
  await phaseProfile(handle, ledger, args.only, personasByIdx, args.parallel);

  console.log('\nPhase DPNS');
  await phaseDpns(handle, ledger, args.only, args.parallel);

  console.log('\nPhase YAPP');
  await phaseYapp(handle, ledger, args.only, args.yapp, args.yappSource, args.parallel);

  await printTable(handle, ledger, args.only);

  const incomplete = selected(ledger, args.only).filter((entry) => entry.state !== 'ready');
  if (incomplete.length > 0) {
    console.error(`\n${incomplete.length} identit(y/ies) incomplete — re-run to resume (see .errors in the ledger)`);
    process.exit(1);
  }
  console.log('\nall identities ready');
  process.exit(0);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
