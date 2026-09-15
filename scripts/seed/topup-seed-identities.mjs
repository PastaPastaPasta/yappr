/**
 * Credit top-up for already-registered seed identities.
 *
 * provision-seed-identities.mjs only funds an identity ONCE, at registration —
 * its phase machine skips anything past `registered`. After a full corpus run
 * the personas' credit balances are largely spent, so a re-seed (e.g. onto a
 * re-registered contract) needs fresh credits. This script reuses the same
 * treasury → SPLIT → LOCK → ChainLock-wait pipeline but ends in
 * `identities.topUp` against the ledger's existing identity ids.
 *
 * Same crash discipline as provisioning: every one-shot asset-lock key and
 * outpoint is persisted to `.seed-topups.local.json` (chmod 600) BEFORE the
 * broadcast that depends on it, and every phase is idempotent — re-run to
 * resume. Never prints private keys.
 *
 * Run:
 *   NETWORK=devnet node scripts/seed/topup-seed-identities.mjs \
 *     --amounts 9:32000000,6:30000000        # personaIdx:duffs, 1 duff = 1000 credits
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { AssetLockProof, OutPoint, PrivateKey, ensureInitialized } from '@dashevo/evo-sdk';
import {
  LEDGER_FILE,
  REPO_ROOT,
  TREASURY_KEY_FILE,
  TRANSPORT_COLLAPSE,
  WAIT_MAYBE_LANDED,
  createSdkHandle,
  describeErr,
  generateKeypairHex,
  loadLedger,
  readback,
  sleep,
  socialContractId,
} from './seed-lib.mjs';
import {
  addressOfPrivateKeyHex,
  broadcastTx,
  buildAssetLockTx,
  buildSplitTx,
  fetchTx,
  fetchUtxos,
} from './asset-lock-lib.mjs';

const TOPUP_FILE = join(REPO_ROOT, '.seed-topups.local.json');
const CHAIN_LOCK_TIMEOUT_MS = 600_000;
const CHAIN_LOCK_POLL_MS = 10_000;

// ---- CLI --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { amounts: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--amounts') args.amounts = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.amounts) throw new Error('--amounts <personaIdx:duffs,…> is required');
  const plan = new Map();
  for (const part of args.amounts.split(',')) {
    const [idx, duffs] = part.split(':').map((s) => Number(s.trim()));
    if (!Number.isInteger(idx) || !Number.isInteger(duffs) || duffs < 1_000_000) {
      throw new Error(`bad --amounts entry "${part}" (want personaIdx:duffs, duffs >= 1,000,000)`);
    }
    plan.set(idx, duffs);
  }
  return plan;
}

// ---- Top-up job store --------------------------------------------------------------

function loadJobs() {
  if (!existsSync(TOPUP_FILE)) return [];
  return JSON.parse(readFileSync(TOPUP_FILE, 'utf8'));
}

function saveJobs(jobs) {
  writeFileSync(TOPUP_FILE, JSON.stringify(jobs, null, 2));
  chmodSync(TOPUP_FILE, 0o600);
}

// ---- Phases -----------------------------------------------------------------------

async function phaseSplit(jobs) {
  const pending = [];
  for (const job of jobs) {
    if (job.state !== 'planned') continue;
    if (job.fundingOutpoint) {
      const tx = await fetchTx(job.fundingOutpoint.txid);
      if (tx) {
        job.state = 'funded';
        saveJobs(jobs);
        console.log(`  persona ${job.personaIdx}: funding tx already on chain`);
        continue;
      }
      delete job.fundingOutpoint;
    }
    pending.push(job);
  }
  if (pending.length === 0) {
    console.log('  nothing to fund');
    return;
  }
  const treasuryKeyHex = readFileSync(TREASURY_KEY_FILE, 'utf8').trim();
  const utxos = await fetchUtxos(addressOfPrivateKeyHex(treasuryKeyHex));
  const recipients = pending.map((job) => ({ address: job.assetLockAddress, duffs: job.duffs }));
  const split = buildSplitTx({ treasuryPrivateKeyHex: treasuryKeyHex, utxos, recipients });
  pending.forEach((job, i) => {
    job.fundingOutpoint = { txid: split.txid, vout: split.recipientVouts[i], duffs: job.duffs };
  });
  saveJobs(jobs); // outpoints recorded BEFORE broadcast
  console.log(`  split tx ${split.txid}: ${pending.length} output(s), fee=${split.fee}, change=${split.changeDuffs}`);
  await broadcastTx(split.rawtx);
  for (const job of pending) job.state = 'funded';
  saveJobs(jobs);
}

async function phaseLock(jobs) {
  for (const job of jobs) {
    if (job.state !== 'funded') continue;
    if (job.lockOutpoint) {
      const tx = await fetchTx(job.lockOutpoint.txid);
      if (tx) {
        job.state = 'locked';
        saveJobs(jobs);
        continue;
      }
      delete job.lockOutpoint;
    }
    let utxo = null;
    for (let attempt = 0; attempt < 9 && !utxo; attempt++) {
      if (attempt > 0) await sleep(10_000);
      const utxos = await fetchUtxos(job.assetLockAddress);
      utxo = utxos.find(
        (u) => u.txid === job.fundingOutpoint.txid && u.vout === job.fundingOutpoint.vout
      ) ?? null;
    }
    if (!utxo) throw new Error(`funding outpoint for persona ${job.personaIdx} not visible after 80s — re-run to resume`);
    const lock = buildAssetLockTx({ privateKeyHex: job.assetLockKeyHex, utxo });
    job.lockOutpoint = { ...lock.outpoint, creditDuffs: lock.creditDuffs };
    saveJobs(jobs); // outpoint recorded BEFORE broadcast
    await broadcastTx(lock.rawtx);
    job.state = 'locked';
    saveJobs(jobs);
    console.log(`  persona ${job.personaIdx}: asset lock ${lock.txid.slice(0, 16)}… (${lock.creditDuffs} duffs locked)`);
  }
}

async function waitForChainLocks(sdk, txids) {
  const heights = new Map();
  const deadline = Date.now() + CHAIN_LOCK_TIMEOUT_MS;
  const remaining = new Set(txids);
  let lockedHeight = 0;
  while (remaining.size > 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for chain locks — re-run to resume');
    for (const txid of remaining) {
      if (heights.has(txid)) continue;
      try {
        const tx = await fetchTx(txid);
        if (tx && typeof tx.blockheight === 'number' && tx.blockheight > 0) heights.set(txid, tx.blockheight);
      } catch { /* insight hiccup — poll again */ }
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
      if (height !== undefined && lockedHeight >= height) remaining.delete(txid);
    }
    if (remaining.size > 0) {
      console.log(`  waiting for chain lock: coreChainLockedHeight=${lockedHeight}, ${remaining.size} tx(s) pending`);
      await sleep(CHAIN_LOCK_POLL_MS);
    }
  }
  return heights;
}

async function phaseTopUp(handle, jobs) {
  const sdk = handle.sdk;
  const locked = jobs.filter((job) => job.state === 'locked');
  if (locked.length === 0) {
    console.log('  nothing to top up');
    return;
  }
  const heights = await waitForChainLocks(sdk, locked.map((job) => job.lockOutpoint.txid));
  for (const job of locked) {
    const proof = AssetLockProof.createChainAssetLockProof(
      heights.get(job.lockOutpoint.txid),
      new OutPoint(job.lockOutpoint.txid, job.lockOutpoint.vout ?? 0)
    );
    const identity = await readback(handle, () => sdk.identities.fetch(job.identityId));
    if (!identity) throw new Error(`identity ${job.identityId} not found`);
    const before = await readback(handle, () => sdk.identities.balance(job.identityId));
    try {
      await sdk.identities.topUp({
        identity,
        assetLockProof: proof,
        assetLockPrivateKey: PrivateKey.fromBytes(Uint8Array.from(Buffer.from(job.assetLockKeyHex, 'hex')), 'testnet'),
      });
    } catch (e) {
      // The gateway 504s the confirmation wait routinely; the balance decides.
      const text = describeErr(e);
      if (!WAIT_MAYBE_LANDED.test(text) && !TRANSPORT_COLLAPSE.test(text)) throw e;
      if (TRANSPORT_COLLAPSE.test(text)) await handle.reconnect(text);
      await sleep(3000);
      const after = await readback(handle, () => sdk.identities.balance(job.identityId));
      if ((after ?? 0n) <= (before ?? 0n)) throw e;
    }
    job.state = 'done';
    saveJobs(jobs);
    const balance = await readback(handle, () => sdk.identities.balance(job.identityId));
    console.log(`  persona ${job.personaIdx}: topped up ${job.identityId} — balance=${balance} credits`);
  }
}

// ---- Main -------------------------------------------------------------------------

const plan = parseArgs(process.argv.slice(2));
const ledger = loadLedger(LEDGER_FILE);
const jobs = loadJobs();

for (const [personaIdx, duffs] of plan) {
  const entry = ledger.identities.find((e) => e.personaIdx === personaIdx);
  if (!entry?.identityId) throw new Error(`persona ${personaIdx} has no registered identity in the ledger`);
  if (jobs.some((job) => job.personaIdx === personaIdx && job.state !== 'done')) continue; // resume it
  const keypair = generateKeypairHex();
  jobs.push({
    personaIdx,
    identityId: entry.identityId,
    duffs,
    assetLockKeyHex: keypair.privateKeyHex,
    assetLockAddress: addressOfPrivateKeyHex(keypair.privateKeyHex),
    state: 'planned',
  });
}
saveJobs(jobs); // keys on disk BEFORE any broadcast

const active = jobs.filter((job) => job.state !== 'done');
console.log(`${active.length} top-up job(s): ${active.map((j) => `${j.personaIdx}:${j.duffs}`).join(', ')}`);
if (active.length === 0) process.exit(0);

await ensureInitialized();

console.log('phase SPLIT');
await phaseSplit(jobs);
console.log('phase LOCK');
await phaseLock(jobs);

console.log('connecting SDK');
const handle = createSdkHandle({
  contractIds: [socialContractId()],
  timeoutMs: 30_000,
  log: (msg) => console.log(`  ${msg}`),
});
const { protocolVersion } = await handle.connect();
console.log(`  connected (PV${protocolVersion ?? '?'})`);

console.log('phase TOPUP');
await phaseTopUp(handle, jobs);
console.log('all top-ups complete');
process.exit(0);
