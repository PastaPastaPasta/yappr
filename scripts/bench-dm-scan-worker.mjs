// Worker half of the parallel scan benchmark (bench-dm-scan.html).
// Module workers do not inherit the page's import map, so noble is loaded by
// path and the trial is inlined rather than imported from the core module.
import * as secp from '/node_modules/@noble/secp256k1/index.js'
import { hmac } from '/node_modules/@noble/hashes/hmac.js'
import { sha256 } from '/node_modules/@noble/hashes/sha2.js'

secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg)
secp.hashes.sha256 = sha256

const subtle = crypto.subtle
const enc = new TextEncoder()
const SALT = enc.encode('yappr/dm/v5')
const OWNER_ID = new Uint8Array(32).fill(7)

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

async function trialDecrypt(priv, inv) {
  const shared = secp.getSharedSecret(priv, inv.epk, true).slice(1, 33)
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const ik = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: concat(enc.encode('invite\0'), inv.epk) },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  try {
    await subtle.decrypt({ name: 'AES-GCM', iv: inv.sealed.slice(0, 12),
      additionalData: concat(enc.encode('yappr/dm/invite/v5'), OWNER_ID, inv.epk) }, ik, inv.sealed.slice(12))
    return true
  } catch {
    return false
  }
}

self.onmessage = async ({ data: { priv, invites } }) => {
  let hits = 0
  for (const inv of invites) if (await trialDecrypt(priv, inv)) hits++
  self.postMessage(hits)
}
