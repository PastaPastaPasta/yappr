// DM v5 invite trial-decryption benchmark (docs/DM_V5.md §5.1.1).
// Measures the per-invite cost of scanning: secp256k1 ECDH with the invite's
// ephemeral key, HKDF, then AES-256-GCM over a 156-byte sealed blob.
//
//   Node:     node -e "import('./scripts/bench-dm-scan-core.mjs').then(m => m.runBench())"
//   Browser:  serve the repo root and open scripts/bench-dm-scan.html, which
//             also measures the same trial spread across Web Workers.
import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg)
secp.hashes.sha256 = sha256

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const SALT = enc.encode('yappr/dm/v5')
const OWNER_ID = new Uint8Array(32).fill(7)

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

async function inviteKey(shared, epk) {
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: concat(enc.encode('invite\0'), epk) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const aad = (epk) => concat(enc.encode('yappr/dm/invite/v5'), OWNER_ID, epk)
const agree = (priv, pub) => secp.getSharedSecret(priv, pub, true).slice(1, 33)

export async function makeInvite(recipientPub) {
  const e = secp.utils.randomSecretKey()
  const epk = secp.getPublicKey(e, true)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(epk) },
    await inviteKey(agree(e, recipientPub), epk), new Uint8Array(128))
  return { epk, sealed: concat(iv, new Uint8Array(ct)) }
}

export async function trialDecrypt(priv, inv) {
  try {
    await subtle.decrypt({ name: 'AES-GCM', iv: inv.sealed.slice(0, 12), additionalData: aad(inv.epk) },
      await inviteKey(agree(priv, inv.epk), inv.epk), inv.sealed.slice(12))
    return true
  } catch {
    return false
  }
}

export async function makeFixture(n) {
  const priv = secp.utils.randomSecretKey()
  const other = secp.getPublicKey(secp.utils.randomSecretKey(), true)
  const invites = []
  for (let i = 0; i < n; i++) invites.push(await makeInvite(other))
  invites.push(await makeInvite(secp.getPublicKey(priv, true)))
  return { priv, invites }
}

export async function runBench(log = console.log, n = 2000) {
  const { priv, invites } = await makeFixture(n)
  for (let i = 0; i < 100; i++) await trialDecrypt(priv, invites[i])
  const t = performance.now()
  let hits = 0
  for (const inv of invites) if (await trialDecrypt(priv, inv)) hits++
  const trialUs = (performance.now() - t) * 1000 / invites.length
  const r = { mode: 'single thread', n: invites.length, trialUs: +trialUs.toFixed(1),
    perSec: Math.round(1e6 / trialUs), hits }
  log(JSON.stringify(r))
  return r
}
