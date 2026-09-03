#!/usr/bin/env node
/**
 * Harvests the moutai faucet into the seed treasury.
 *
 * The faucet (MultiFaucet) pays 10 DASH per request but rate-limits PER
 * ADDRESS, not per IP (verified 2026-09-03: twelve repeat POSTs to the
 * treasury paid nothing; a fresh address paid immediately). So each drip goes
 * to a fresh one-shot key, and once the drips confirm they are swept into the
 * treasury in one transaction. Keys are written to the ledger BEFORE the
 * request that depends on them, so a crash never strands funds.
 *
 *   node scripts/seed/faucet-harvest.mjs --drips 20          # request 20 × 10 DASH
 *   node scripts/seed/faucet-harvest.mjs --sweep            # sweep confirmed drips → treasury
 *   node scripts/seed/faucet-harvest.mjs --drips 20 --sweep # both (sweep waits for confirmations)
 *
 * Ledger: .seed-faucet.local.json (chmod 600, gitignored).
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import dashcore from '@dashevo/dashcore-lib';
const { PrivateKey, Transaction } = dashcore;
import { fetchUtxos, broadcastTx, SPLIT_FEE_PER_KB } from './asset-lock-lib.mjs';
import { REPO_ROOT } from '../derive-identities.mjs';
import { join } from 'node:path';

const FAUCET = 'https://faucet.moutai.networks.dash.org/';
const LEDGER = join(REPO_ROOT, '.seed-faucet.local.json');
const TREASURY_KEY_FILE = join(REPO_ROOT, '.seed-treasury.local.key');
const DRIP_DUFFS = 10n * 100_000_000n;
const PAUSE_MS = 4_000;

const args = { drips: 0, sweep: false };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--drips') args.drips = Number(process.argv[++i]);
  else if (process.argv[i] === '--sweep') args.sweep = true;
  else throw new Error(`unknown argument ${process.argv[i]}`);
}

const load = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { drips: [] });
const save = (l) => { writeFileSync(LEDGER, JSON.stringify(l, null, 2)); chmodSync(LEDGER, 0o600); };
const treasuryAddress = () => new PrivateKey(readFileSync(TREASURY_KEY_FILE, 'utf8').trim(), 'testnet').toAddress('testnet').toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestDrip(address) {
  const body = new URLSearchParams({ cryptocoin_address: address, promo_code: '', cryptocoin_submit: 'Get coins' });
  const res = await fetch(FAUCET, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: FAUCET }, signal: AbortSignal.timeout(30_000) });
  return res.status;
}

async function drip(ledger, n) {
  for (let i = 0; i < n; i++) {
    const key = new PrivateKey(undefined, 'testnet');
    const entry = { address: key.toAddress('testnet').toString(), wif: key.toWIF(), requestedAt: new Date().toISOString(), state: 'requested' };
    ledger.drips.push(entry); save(ledger); // key persisted before the faucet sees the address
    try {
      const status = await requestDrip(entry.address);
      entry.httpStatus = status; save(ledger);
      console.log(`  drip ${i + 1}/${n} → ${entry.address} http=${status}`);
    } catch (e) {
      entry.error = String(e?.message ?? e); save(ledger);
      console.log(`  drip ${i + 1}/${n} → ${entry.address} FAILED ${entry.error.slice(0, 80)}`);
    }
    await sleep(PAUSE_MS);
  }
}

async function sweep(ledger) {
  const treasury = treasuryAddress();
  const pending = ledger.drips.filter((d) => d.state === 'requested');
  const inputs = []; const keys = [];
  for (const d of pending) {
    let utxos = [];
    try { utxos = await fetchUtxos(d.address); } catch { continue; }
    const confirmed = utxos.filter((u) => (u.confirmations ?? 0) >= 1);
    if (confirmed.length === 0) { console.log(`  ${d.address}: not yet confirmed (${utxos.length} utxo(s) seen)`); continue; }
    for (const u of confirmed) inputs.push({ txId: u.txid, outputIndex: u.vout, address: d.address, script: u.scriptPubKey, satoshis: u.satoshis });
    keys.push(new PrivateKey(d.wif, 'testnet'));
    d.swept = confirmed.map((u) => `${u.txid}:${u.vout}`);
  }
  if (inputs.length === 0) { console.log('  nothing confirmed to sweep'); return; }
  const total = inputs.reduce((s, u) => s + u.satoshis, 0);
  const tx = new Transaction().from(inputs).feePerKb(SPLIT_FEE_PER_KB).change(treasury).sign(keys);
  const txid = tx.id;
  for (const d of pending) if (d.swept) { d.state = 'sweeping'; d.sweepTxid = txid; }
  save(ledger); // outpoints + txid recorded BEFORE broadcast
  await broadcastTx(tx.uncheckedSerialize());
  for (const d of pending) if (d.sweepTxid === txid) d.state = 'swept';
  save(ledger);
  console.log(`  swept ${inputs.length} drip(s), ${(total / 1e8).toFixed(2)} DASH → ${treasury} (tx ${txid.slice(0, 16)}…, fee ${tx.getFee()})`);
}

const ledger = load();
if (args.drips > 0) { console.log(`requesting ${args.drips} drip(s) of ${Number(DRIP_DUFFS) / 1e8} DASH …`); await drip(ledger, args.drips); }
if (args.sweep) { console.log('sweeping confirmed drips into the treasury …'); await sweep(ledger); }
const requested = ledger.drips.filter((d) => d.state === 'requested').length;
const swept = ledger.drips.filter((d) => d.state === 'swept').length;
console.log(`ledger: ${ledger.drips.length} drip(s) total — ${requested} awaiting sweep, ${swept} swept`);
