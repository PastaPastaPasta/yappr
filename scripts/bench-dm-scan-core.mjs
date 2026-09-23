// DM v5 invite trial-decryption benchmark (docs/DM_V5.md §5.1.1).
// Measures the per-invite cost of scanning: key agreement with the invite's
// ephemeral key, HKDF, then AES-256-GCM over a 156-byte sealed blob. Runs the
// secp256k1 path (@noble, JS) and the X25519 path (native WebCrypto).
//
//   Node:     node -e "import('./scripts/bench-dm-scan-core.mjs').then(m => m.runBench())"
//   Browser:  serve the repo root and open scripts/bench-dm-scan.html
import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg)
secp.hashes.sha256 = sha256

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const SALT = enc.encode('yappr/dm/v5')
const OWNER_ID = crypto.getRandomValues(new Uint8Array(32))

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

async function seal(shared, epk) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(epk) }, await inviteKey(shared, epk), new Uint8Array(128))
  return { epk, sealed: concat(iv, new Uint8Array(ct)) }
}

async function open(shared, inv) {
  try {
    await subtle.decrypt({ name: 'AES-GCM', iv: inv.sealed.slice(0, 12), additionalData: aad(inv.epk) },
      await inviteKey(shared, inv.epk), inv.sealed.slice(12))
    return true
  } catch {
    return false
  }
}

const secpCurve = {
  name: 'secp256k1 (noble JS)',
  async keypair() {
    const priv = secp.utils.randomSecretKey()
    return { priv, pub: secp.getPublicKey(priv, true) }
  },
  async agree(priv, pub) {
    return secp.getSharedSecret(priv, pub, true).slice(1, 33)
  },
}

const x25519Curve = {
  name: 'X25519 (WebCrypto)',
  async keypair() {
    const k = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    return { priv: k.privateKey, pub: new Uint8Array(await subtle.exportKey('raw', k.publicKey)) }
  },
  async agree(priv, pub) {
    const pk = await subtle.importKey('raw', pub, { name: 'X25519' }, false, [])
    return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pk }, priv, 256))
  },
}

async function benchCurve(curve, n) {
  const me = await curve.keypair()
  const other = await curve.keypair()
  const makeInvite = async (recipientPub) => {
    const e = await curve.keypair()
    return seal(await curve.agree(e.priv, recipientPub), e.pub)
  }
  const invites = []
  for (let i = 0; i < n; i++) invites.push(await makeInvite(other.pub))
  const mine = await makeInvite(me.pub)
  const trial = async (inv) => open(await curve.agree(me.priv, inv.epk), inv)

  for (let i = 0; i < 100; i++) await trial(invites[i])
  const t = performance.now()
  let falsePositives = 0
  for (const inv of invites) if (await trial(inv)) falsePositives++
  const trialUs = (performance.now() - t) * 1000 / n

  return { curve: curve.name, n, trialUs: +trialUs.toFixed(1), perSec: Math.round(1e6 / trialUs),
    falsePositives, ownInviteFound: await trial(mine) }
}

export async function runBench(log = console.log, n = 2000) {
  const results = []
  for (const curve of [secpCurve, x25519Curve]) {
    const r = await benchCurve(curve, n)
    log(JSON.stringify(r))
    results.push(r)
  }
  return results
}
