/**
 * Shared owner-identity/key resolution for the contract admin scripts.
 *
 * Two kinds of signing identities exist on testnet:
 *  - the "contract maker" (owner of the production/staging contracts): keys live in
 *    `~/Downloads/dash-identity-testnet-contract-maker.json` (never committed);
 *  - the e2e bot pool derived from `E2E_SEED_PHRASE` (see derive-identities.mjs),
 *    used for scratch registrations and the /testing contracts.
 *
 * Nothing here prints private key material.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IdentitySigner } from '@dashevo/evo-sdk';
import { CRITICAL_AUTH_KEY_ID, criticalAuthKey, deriveIdentityKeys, loadIdentityIds } from './derive-identities.mjs';
import { network } from './sdk-env.mjs';

const MAKER_IDENTITY_FILE = join(homedir(), 'Downloads', 'dash-identity-testnet-contract-maker.json');
/** Contract create/update transitions must be signed with a CRITICAL AUTHENTICATION key. */
const MAKER_CRITICAL_KEY_ID = 2;

/** Compressed testnet WIFs, so a key echoed back inside an error never reaches the console. */
export const WIF_PATTERN = /\b[c9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;

export function describeErr(e) {
  if (!e) return String(e);
  const parts = [];
  for (const k of ['message', 'name', 'code', 'cause']) if (e[k] !== undefined) parts.push(`${k}=${e[k]}`);
  try { parts.push(`toString=${e.toString()}`); } catch { /* ignore */ }
  try { parts.push(`json=${JSON.stringify(e)}`); } catch { /* ignore */ }
  return parts.join(' | ').replace(WIF_PATTERN, '<redacted-key>');
}

/**
 * Resolves `--maker` / `--bot <index>` flags to `{ownerId, keyId, wif, label}`.
 * The WIF stays inside the returned object; callers feed it to an IdentitySigner.
 */
export function resolveOwner({ maker, botIndex, ownerId }) {
  if (maker) {
    const json = JSON.parse(readFileSync(MAKER_IDENTITY_FILE, 'utf8'));
    const key = (json.identityKeys ?? []).find((k) => k.id === MAKER_CRITICAL_KEY_ID);
    if (!key?.privateKeyWif) {
      throw new Error(`No key id ${MAKER_CRITICAL_KEY_ID} with privateKeyWif in ${MAKER_IDENTITY_FILE}`);
    }
    return {
      ownerId: ownerId ?? json.identityId,
      keyId: MAKER_CRITICAL_KEY_ID,
      wif: key.privateKeyWif,
      publicKeyHex: key.publicKeyHex,
      label: `maker(${json.identityId})`,
    };
  }
  const index = botIndex ?? 0;
  const key = criticalAuthKey(deriveIdentityKeys(index));
  const resolvedId = ownerId ?? loadIdentityIds()[index];
  if (!resolvedId) {
    throw new Error(`No identity id for bot index ${index}: pass --owner or extend E2E_IDENTITY_IDS`);
  }
  return {
    ownerId: resolvedId,
    keyId: CRITICAL_AUTH_KEY_ID,
    wif: key.wif,
    publicKeyHex: key.publicKeyHex,
    label: `bot${index}(${resolvedId})`,
  };
}

/**
 * Fetches the identity, checks the on-chain key matches the local WIF, and
 * returns `{identityKey, signer}` ready for contracts.publish/update.
 */
export async function signerFor(sdk, owner) {
  const identity = await sdk.identities.fetch(owner.ownerId);
  if (!identity) throw new Error(`Identity ${owner.ownerId} not found on ${network()}`);
  const identityKey = identity.getPublicKeyById(owner.keyId);
  if (!identityKey) throw new Error(`Identity ${owner.ownerId} has no key ${owner.keyId}`);
  if (owner.publicKeyHex) {
    // 4.2 returns key data as base64; older builds returned number[] — accept both.
    const rawData = identityKey.toObject().data;
    const onChain = Array.isArray(rawData) ? Buffer.from(rawData) : Buffer.from(rawData, 'base64');
    // ECDSA_HASH160 keys store hash160(pubkey) on-chain (20 bytes), full keys store 33.
    const local = Buffer.from(owner.publicKeyHex, 'hex');
    const localCompare = onChain.length === 20
      ? createHash('ripemd160').update(createHash('sha256').update(local).digest()).digest()
      : local;
    if (!onChain.equals(localCompare)) {
      throw new Error(`Identity ${owner.ownerId} key ${owner.keyId} does not match the local private key`);
    }
  }
  const signer = new IdentitySigner();
  signer.addKeyFromWif(owner.wif);
  return { identityKey, signer };
}
