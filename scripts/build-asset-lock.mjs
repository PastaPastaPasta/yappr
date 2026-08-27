/**
 * Builds and broadcasts the Asset Lock SPECIAL transaction (DIP-2 type 8) that
 * Platform identity registration actually requires.
 *
 * A faucet pays a plain P2PKH — Platform rejects that outpoint with "Funding
 * transaction must have an Asset Lock Special Transaction Payload". This script
 * spends the faucet UTXO into a proper asset-lock tx, shaped exactly per
 * platform `v4.2-dev`'s validate_asset_lock_transaction_structure_v0:
 *
 *   - transaction version 3, type 8 (TRANSACTION_ASSET_LOCK)
 *   - visible outputs: ONE OP_RETURN "burn" output carrying the locked value
 *   - extraPayload: AssetLockPayload { creditOutputs: [P2PKH(one-time key)] }
 *   - the asset-lock proof outpoint is (thisTxid, 0) — index into creditOutputs
 *
 * The one-time key doubles as the faucet-UTXO key here (both are the keyfile
 * written by provision-test-identity.mjs --gen-asset-lock-key), so no new key
 * material is created and .devnet-locks.local already covers recovery.
 *
 * Run:
 *   NETWORK=devnet node scripts/build-asset-lock.mjs --key-file <keyfile> --outpoint <txid>:<vout>
 * then (NETWORK is process-local — repeat it, or provisioning targets testnet):
 *   NETWORK=devnet node scripts/provision-test-identity.mjs <idx> --asset-lock-key-file <keyfile> \
 *     --funding-outpoint <printedTxid>:0 [--chain-lock <height>]
 */
import { readFileSync } from 'node:fs';
import dashcore from '@dashevo/dashcore-lib';

const { PrivateKey, Transaction, Script, Address, Opcode } = dashcore;
const FEE_DUFFS = 500;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function insightBase() {
  return process.env.INSIGHT_API_URL || 'https://insight.moutai.networks.dash.org/insight-api';
}

const keyFile = arg('--key-file');
const outpoint = arg('--outpoint');
if (!keyFile || !outpoint) {
  console.error('usage: build-asset-lock.mjs --key-file <file> --outpoint <txid>:<vout>');
  process.exit(2);
}
const [fundingTxid, fundingVoutRaw] = outpoint.split(':');
const fundingVout = Number(fundingVoutRaw);

const hex = readFileSync(keyFile, 'utf8').trim();
if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${keyFile} is not a 64-hex private key`);
const privateKey = new PrivateKey(hex, 'testnet'); // devnets use testnet prefixes
const address = privateKey.toAddress('testnet');

// Pull the UTXO being spent (script + value) and sanity-check it pays our key.
const utxos = await (await fetch(`${insightBase()}/addr/${address}/utxo`)).json();
const utxo = utxos.find((u) => u.txid === fundingTxid && u.vout === fundingVout);
if (!utxo) throw new Error(`outpoint ${outpoint} not found among UTXOs of ${address}`);

const creditDuffs = utxo.satoshis - FEE_DUFFS;
if (creditDuffs <= 0) throw new Error(`UTXO too small: ${utxo.satoshis}`);

const payload = Transaction.Payload.AssetLockPayload.fromJSON({
  version: 1,
  creditOutputs: [{
    satoshis: creditDuffs,
    script: Script.buildPublicKeyHashOut(address).toString(),
  }],
});

const tx = new Transaction()
  .setType(Transaction.TYPES.TRANSACTION_ASSET_LOCK)
  .from([{
    txId: fundingTxid,
    outputIndex: fundingVout,
    script: utxo.scriptPubKey,
    satoshis: utxo.satoshis,
    address: address.toString(),
  }])
  .addOutput(new Transaction.Output({
    satoshis: creditDuffs,
    script: new Script().add(Opcode.OP_RETURN).add(Buffer.alloc(0)),
  }))
  .setExtraPayload(payload)
  .sign(privateKey);

const rawtx = tx.uncheckedSerialize();
console.log(`built asset-lock tx: ${tx.id} (${rawtx.length / 2} bytes, credit=${creditDuffs} duffs)`);

const res = await fetch(`${insightBase()}/tx/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rawtx }),
});
const body = await res.text();
if (!res.ok) throw new Error(`broadcast failed (${res.status}): ${body.slice(0, 300)}`);
console.log(`broadcast ok: ${body.slice(0, 200)}`);
console.log(`asset-lock outpoint for provisioning: ${tx.id}:0`);
