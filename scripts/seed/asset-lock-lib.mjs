/**
 * Core-chain transaction construction + Insight API access for the seed
 * provisioning flow. The construction functions are PURE (given UTXOs they
 * build and sign locally, no network), so `--self-test` can exercise them with
 * fabricated UTXOs; only the fetch/broadcast helpers touch Insight.
 *
 * The asset-lock construction mirrors scripts/build-asset-lock.mjs (kept
 * untouched), shaped exactly per platform's
 * validate_asset_lock_transaction_structure_v0:
 *   - transaction version 3, type 8 (TRANSACTION_ASSET_LOCK, DIP-2)
 *   - visible outputs: ONE OP_RETURN "burn" output carrying the locked value
 *   - extraPayload: AssetLockPayload { creditOutputs: [P2PKH(one-shot key)] }
 *   - the asset-lock proof outpoint is (thisTxid, 0) — an index into
 *     creditOutputs, not the visible outputs
 *
 * Fees: the moutai devnet runs a LOW maxtxfee, so everything here stays in the
 * ~1000 duffs/kB class. The split transaction uses dashcore's feePerKb with a
 * floor; the asset lock uses the same flat 500 duffs build-asset-lock.mjs uses.
 */
import dashcore from '@dashevo/dashcore-lib';
import { insightUrl } from './seed-lib.mjs';

const { PrivateKey, Transaction, Script, Opcode } = dashcore;

/** Flat fee of the (1-in, 1-out + payload) asset-lock special tx. */
export const ASSET_LOCK_FEE_DUFFS = 500;
/** Devnet-friendly fee rate for the split transaction. */
export const SPLIT_FEE_PER_KB = 1000;
/** Devnets reuse testnet address/WIF prefixes (moutai Insight reports "testnet"). */
const CHAIN = 'testnet';

// ---- Insight API (network) -----------------------------------------------------

export async function fetchUtxos(address) {
  const response = await fetch(`${insightUrl()}/addr/${address}/utxo`);
  if (!response.ok) throw new Error(`Insight UTXO lookup for ${address} failed (${response.status})`);
  return response.json();
}

/** Returns the tx JSON, or null while unknown/unconfirmed lookups 404. */
export async function fetchTx(txid) {
  const response = await fetch(`${insightUrl()}/tx/${txid}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Insight tx lookup for ${txid} failed (${response.status})`);
  return response.json();
}

export async function broadcastTx(rawtx) {
  const response = await fetch(`${insightUrl()}/tx/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawtx }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`broadcast failed (${response.status}): ${body.slice(0, 300)}`);
  return body.slice(0, 200);
}

// ---- Pure construction -----------------------------------------------------------

function toDashcoreUtxo(utxo, address) {
  return {
    txId: utxo.txid,
    outputIndex: utxo.vout,
    script: utxo.scriptPubKey,
    satoshis: utxo.satoshis,
    address: String(address),
  };
}

/**
 * The SPLIT transaction: spends treasury UTXOs into one P2PKH output per
 * recipient (a fresh one-shot asset-lock address each), change back to the
 * treasury. UTXOs are selected largest-first until the target is covered.
 *
 * @param {string} treasuryPrivateKeyHex 64-hex treasury key
 * @param {Array} utxos Insight-shaped UTXOs of the treasury address
 * @param {Array<{address: string, duffs: number}>} recipients
 * @returns {{tx, txid, rawtx, fee, changeDuffs, inputsUsed}}
 */
export function buildSplitTx({ treasuryPrivateKeyHex, utxos, recipients }) {
  if (!/^[0-9a-fA-F]{64}$/.test(treasuryPrivateKeyHex ?? '')) {
    throw new Error('treasury key must be a 64-hex private key');
  }
  if (!recipients?.length) throw new Error('no recipients for the split transaction');
  const privateKey = new PrivateKey(treasuryPrivateKeyHex, CHAIN);
  const treasuryAddress = privateKey.toAddress(CHAIN);

  const target = recipients.reduce((sum, r) => sum + r.duffs, 0);
  // ~148 B/input + ~34 B/output + 10 B overhead at SPLIT_FEE_PER_KB, with headroom.
  const feeCeiling = (n) => Math.ceil(((n * 148 + (recipients.length + 1) * 34 + 10) / 1000) * SPLIT_FEE_PER_KB) + 200;

  const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
  const selected = [];
  let inTotal = 0;
  for (const utxo of sorted) {
    selected.push(utxo);
    inTotal += utxo.satoshis;
    if (inTotal >= target + feeCeiling(selected.length)) break;
  }
  if (inTotal < target + feeCeiling(selected.length)) {
    throw new Error(
      `treasury balance too low: have ${inTotal} duffs across ${utxos.length} UTXO(s), ` +
      `need ${target} + ~${feeCeiling(selected.length)} fee. Send more devnet DASH to ${treasuryAddress}.`
    );
  }

  const tx = new Transaction()
    .from(selected.map((utxo) => toDashcoreUtxo(utxo, treasuryAddress)))
    .feePerKb(SPLIT_FEE_PER_KB);
  for (const recipient of recipients) tx.to(recipient.address, recipient.duffs);
  tx.change(treasuryAddress).sign(privateKey);

  const changeOutput = tx.getChangeOutput();
  return {
    tx,
    txid: tx.id,
    rawtx: tx.uncheckedSerialize(),
    fee: tx.getFee(),
    changeDuffs: changeOutput ? changeOutput.satoshis : 0,
    inputsUsed: selected.length,
    /** vout of each recipient, in `recipients` order (outputs precede change). */
    recipientVouts: recipients.map((_, i) => i),
  };
}

/**
 * The DIP-2 type-8 asset-lock special transaction, spending ONE funding UTXO
 * controlled by the one-shot key. The same key owns the creditOutputs P2PKH, so
 * the ledger entry that recorded the one-shot key already covers recovery.
 *
 * @returns {{tx, txid, rawtx, creditDuffs, outpoint: {txid, vout: 0}}}
 */
export function buildAssetLockTx({ privateKeyHex, utxo }) {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex ?? '')) throw new Error('expected a 64-hex one-shot private key');
  const privateKey = new PrivateKey(privateKeyHex, CHAIN);
  const address = privateKey.toAddress(CHAIN);

  const creditDuffs = utxo.satoshis - ASSET_LOCK_FEE_DUFFS;
  if (creditDuffs <= 0) throw new Error(`funding UTXO too small: ${utxo.satoshis} duffs`);

  const payload = Transaction.Payload.AssetLockPayload.fromJSON({
    version: 1,
    creditOutputs: [{
      satoshis: creditDuffs,
      script: Script.buildPublicKeyHashOut(address).toString(),
    }],
  });

  const tx = new Transaction()
    .setType(Transaction.TYPES.TRANSACTION_ASSET_LOCK)
    .from([toDashcoreUtxo(utxo, address)])
    .addOutput(new Transaction.Output({
      satoshis: creditDuffs,
      script: new Script().add(Opcode.OP_RETURN).add(Buffer.alloc(0)),
    }))
    .setExtraPayload(payload)
    .sign(privateKey);

  return {
    tx,
    txid: tx.id,
    rawtx: tx.uncheckedSerialize(),
    creditDuffs,
    outpoint: { txid: tx.id, vout: 0 },
  };
}

/** P2PKH address of a 64-hex private key on the devnet (testnet prefixes). */
export function addressOfPrivateKeyHex(privateKeyHex) {
  return new PrivateKey(privateKeyHex, CHAIN).toAddress(CHAIN).toString();
}

/** A synthetic Insight-shaped UTXO paying `privateKeyHex`'s address (self-tests). */
export function fakeUtxoFor(privateKeyHex, satoshis, { txid, vout = 0 } = {}) {
  const address = new PrivateKey(privateKeyHex, CHAIN).toAddress(CHAIN);
  return {
    txid: txid ?? 'f'.repeat(64),
    vout,
    scriptPubKey: Script.buildPublicKeyHashOut(address).toHex(),
    satoshis,
    address: address.toString(),
  };
}
