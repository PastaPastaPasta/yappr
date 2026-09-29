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
 * --parallel N runs the per-identity phases REGISTER/PROFILE/DPNS/YAPP-claim
 * N identities at a time — maker YAPP mints stay serial):
 *   SPLIT     one core-chain tx spends treasury UTXO(s) into one P2PKH output
 *             per identity (default 8,000,000 duffs, --credits-per overrides),
 *             each paying a fresh one-shot asset-lock key; change → treasury
 *   LOCK      per identity, a DIP-2 type-8 asset-lock special tx spends its
 *             funding output (proof outpoint = txid:0)
 *   REGISTER  wait for ChainLock coverage (Insight height + DAPI getStatus —
 *             InstantSend proofs are REFUSED on moutai), then create the
 *             identity with 5 fresh random keys (same purpose/security-level
 *             set as the e2e bots)
 *   PROFILE   the persona's profile on v10: a DashPay `profile` (displayName,
 *             publicMessage = bio) first, then the social `yapprProfile`
 *             extension (location, website, the DiceBear avatar recipe), which
 *             consensus refuses without the DashPay profile (40120). Each is
 *             unique per owner, so a re-run finds and skips what exists.
 *   DPNS      register the persona's handle
 *   YAPP      fund each identity with YAPP (the social contract charges YAPP
 *             per post/reply/like create). v10's YAPP is paused for good and
 *             has no purchase price, so neither a transfer nor a direct
 *             purchase can ever land; the two sources are:
 *               --yapp-source claim     the identity claims its 100 YAPP
 *                                       once-per-identity starter grant itself
 *                                       (parallel), then the maker mints the rest
 *               --yapp-source maker     (default) the devnet maker (the contract
 *                                       owner, seed index 9, keys from
 *                                       E2E_SEED_PHRASE, id from
 *                                       DEVNET_MAKER_IDENTITY_ID in .env.devnet)
 *                                       MINTS the whole amount to the identity
 *                                       (mintingAllowChoosingDestination), serial
 *
 * Setup: put a 64-hex private key in `.seed-treasury.local.key` (chmod 600) and
 * send devnet DASH to its address (printed by --treasury-address) from the
 * devnet faucet (bonsia: https://faucet.bonsia.networks.dash.org/).
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
  ALREADY_CLAIMED,
  CRITICAL_AUTH_KEY_ID,
  DASHPAY_CONTRACT_ID,
  DUPLICATE_UNIQUE,
  LEDGER_FILE,
  STARTER_GRANT,
  TREASURY_KEY_FILE,
  YAPP_TOKEN_POSITION,
  addressFor,
  buildDocument,
  createSdkHandle,
  describeErr,
  generateIdentityKeySet,
  generateKeypairHex,
  landedAfter,
  ledgerEntry,
  loadLedger,
  loadPersonas,
  network,
  profileDocumentsFor,
  profileLimits,
  randomEntropy,
  readback,
  saveLedger,
  sleep,
  socialContractId,
  stateRank,
  tokenBalance,
  validateHandle,
  validatePersona,
  wifFromHex,
} from './seed-lib.mjs';
import { signerFor } from '../owner-keys.mjs';
import { resolveMakerOwner } from '../social-battery-lib.mjs';
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
  if (!['maker', 'claim'].includes(args.yappSource)) {
    throw new Error('--yapp-source must be "maker" (owner mint from seed index 9) or "claim" (the starter grant, then a mint for the rest); YAPP can no longer be transferred or bought');
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
        if (!(await landedAfter(handle, e, async () => Boolean(await readback(handle, () => sdk.identities.fetch(identityIdBase58)))))) throw e;
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
  const socialId = socialContractId();
  const todo = selected(ledger, only).filter((entry) => stateRank(entry.state) === stateRank('registered'));
  await forEachParallel(todo, parallel, async (entry) => {
    try {
      const persona = personasByIdx.get(entry.personaIdx);
      if (!persona) throw new Error(`persona ${entry.personaIdx} missing from the personas file`);
      const identity = await readback(handle, () => sdk.identities.fetch(entry.identityId));
      if (!identity) throw new Error(`identity ${entry.identityId} not readable`);
      const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
      const signer = buildSignerFor(entry);
      const documents = profileDocumentsFor(persona);
      // DashPay first: the extension's ownerRefersTo finds it by $ownerId (40120 without).
      const wrote = [];
      for (const [contractId, docType, data] of [[DASHPAY_CONTRACT_ID, 'profile', documents.dashpay], [socialId, 'yapprProfile', documents.extension]]) {
        if (await createUniqueByOwner(handle, { contractId, docType, entry, identityKey, signer, data })) wrote.push(docType);
      }
      entry.state = 'profiled';
      saveLedger(ledger);
      console.log(`  persona ${entry.personaIdx}: ${wrote.length > 0 ? `wrote ${wrote.join(' + ')}` : 'profile already exists'} ("${persona.displayName}")`);
    } catch (e) {
      noteError(ledger, entry, 'profile', e);
    }
  });
}

/**
 * Creates `docType` for `entry` unless one exists (both profile types are
 * unique by $ownerId). Answers true when it wrote one. The id is only known
 * from a create that RETURNED (protocol 14), so a create that threw on its
 * wait is reconciled by the same by-owner read the idempotency check uses.
 */
async function createUniqueByOwner(handle, { contractId, docType, entry, identityKey, signer, data }) {
  const sdk = handle.sdk;
  const find = () => readback(handle, () => sdk.documents.query({
    dataContractId: contractId, documentTypeName: docType, where: [['$ownerId', '==', entry.identityId]], limit: 1,
  }));
  if ((await find()).size > 0) return false;
  const { document } = buildDocument({ contractId, docType, ownerId: entry.identityId, entropy: randomEntropy(), data });
  try {
    await sdk.documents.create({ document, identityKey, signer });
  } catch (e) {
    if (DUPLICATE_UNIQUE.test(describeErr(e))) return false; // a previous run got there first
    if (!(await landedAfter(handle, e, async () => (await find()).size > 0))) throw e;
  }
  return true;
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
        const named = async () => Boolean((await readback(handle, () => sdk.dpns.username(entry.identityId)))?.toLowerCase().startsWith(`${entry.handle}.`));
        if (!(await landedAfter(handle, e, named))) throw e;
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

/**
 * The devnet maker (the contract owner, seed index 9, DEVNET_MAKER_IDENTITY_ID;
 * its key needs E2E_SEED_PHRASE in the env or .env.local): the only identity
 * that may mint YAPP.
 */
async function makerContext(handle) {
  const owner = resolveMakerOwner();
  const { identityKey, signer } = await signerFor(handle.sdk, owner);
  return { makerId: owner.ownerId, identityKey, signer };
}

async function phaseYapp(handle, ledger, only, yappTarget, yappSource, parallel) {
  const sdk = handle.sdk;
  const contractId = socialContractId();
  const tokenId = await readback(handle, () => sdk.tokens.calculateId(contractId, YAPP_TOKEN_POSITION));
  const balanceOf = (entry) => tokenBalance((fn) => readback(handle, fn), sdk, tokenId, entry.identityId);
  const reconciled = (e, entry, target) => landedAfter(handle, e, async () => (await balanceOf(entry)) >= target);

  // Lazy: the maker keys are not touched unless an identity actually needs a mint
  // (so a fully-provisioned re-run needs no seed phrase).
  let makerPromise = null;
  const getMaker = () => (makerPromise ??= makerContext(handle));

  /** The identity's own once-per-identity claim (a claim is not a transfer: the paused token pays it). */
  const claim = async (entry, balance) => {
    const identity = await readback(handle, () => sdk.identities.fetch(entry.identityId));
    const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
    console.log(`  persona ${entry.personaIdx}: claiming the ${STARTER_GRANT} YAPP starter grant …`);
    try {
      await sdk.tokens.claim({ dataContractId: contractId, tokenPosition: YAPP_TOKEN_POSITION, identityId: entry.identityId, distributionType: 'oncePerIdentity', identityKey, signer: buildSignerFor(entry) });
    } catch (e) {
      // 40722: claimed on an earlier run; the balance read below decides.
      if (!ALREADY_CLAIMED.test(describeErr(e)) && !(await reconciled(e, entry, balance + STARTER_GRANT))) throw e;
    }
    return balanceOf(entry);
  };

  /** The maker (contract owner) mints `amount` straight to the identity. */
  const mint = async (entry, amount, target) => {
    const maker = await getMaker();
    console.log(`  persona ${entry.personaIdx}: minting ${amount} YAPP from the maker …`);
    try {
      await sdk.tokens.mint({ dataContractId: contractId, tokenPosition: YAPP_TOKEN_POSITION, amount, identityId: maker.makerId, recipientId: entry.identityId, identityKey: maker.identityKey, signer: maker.signer });
    } catch (e) {
      if (!(await reconciled(e, entry, target))) throw e;
    }
  };

  const todo = selected(ledger, only).filter((entry) => stateRank(entry.state) === stateRank('named'));
  const ready = (entry, note) => { entry.state = 'ready'; saveLedger(ledger); if (note) console.log(`  persona ${entry.personaIdx}: ${note}`); };
  const shortfall = new Map();
  // Claims are each identity's own transition and parallelise; mints all spend the
  // maker's nonce sequence, so they run one at a time afterwards.
  await forEachParallel(todo, yappSource === 'claim' ? parallel : 1, async (entry) => {
    try {
      if (yappTarget === 0n) return ready(entry);
      let balance = await balanceOf(entry);
      if (balance < yappTarget && yappSource === 'claim' && !entry.starterClaimed) {
        balance = await claim(entry, balance);
        entry.starterClaimed = true;
        saveLedger(ledger);
      }
      if (balance >= yappTarget) return ready(entry, `holds ${balance} YAPP`);
      shortfall.set(entry, yappTarget - balance);
    } catch (e) {
      noteError(ledger, entry, 'yapp', e);
    }
  });
  for (const [entry, amount] of shortfall) {
    try {
      await mint(entry, amount, yappTarget);
      ready(entry, 'YAPP funded');
    } catch (e) {
      noteError(ledger, entry, 'yapp', e);
    }
  }
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
  const persona = { idx: 0, handle: 'alice42', displayName: 'Alice', bio: 'hi', avatarSeed: 'alice-seed', location: 'Lisbon' };
  check('persona: valid persona passes', validatePersona(persona, limits).length === 0);
  check('persona: displayName over DashPay\'s 25 fails', validatePersona({ ...persona, displayName: 'x'.repeat(26) }, limits).length > 0);
  check('persona: bio over DashPay\'s 140 fails', validatePersona({ ...persona, bio: 'x'.repeat(141) }, limits).length > 0);
  check('persona: bad website fails', validatePersona({ ...persona, website: 'ftp://x' }, limits).length > 0);
  const documents = profileDocumentsFor(persona);
  check('profile: the DashPay document carries the name and the bio as publicMessage',
    JSON.stringify(documents.dashpay) === JSON.stringify({ displayName: 'Alice', publicMessage: 'hi' }));
  check('profile: the extension carries the rest and a stable DiceBear recipe',
    documents.extension.location === 'Lisbon' && documents.extension.avatar === profileDocumentsFor(persona).extension.avatar && !('displayName' in documents.extension));

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
  console.error('         [--credits-per <duffs>] [--yapp <tokens>] [--yapp-source maker|claim] [--only <idx,idx>]');
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
  console.log('fund it from the devnet faucet (bonsia: https://faucet.bonsia.networks.dash.org/) — see scripts/seed/README.md for amounts');
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
    contractIds: [socialContractId(), DASHPAY_CONTRACT_ID],
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
