#!/usr/bin/env node
// Prints, one per line on stdout, every private key the pool holds for the given personas,
// in each form a log could show: hex, WIF (devnet/testnet prefix, compressed), and the four
// parts run.sh types a key in. run.sh redacts them all from what a run writes (the app
// persona's keys, and the peer's and the responder's, whose processes also hold keys);
// the CI workflow masks them. Keys go to stdout only, never to argv or a file.
//
//   node mobile/e2e/host/persona-secrets.mjs <identities.json> <persona> [<persona>...]
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [pool, ...personas] = process.argv.slice(2)
if (!pool || personas.length === 0) {
  console.error('usage: persona-secrets.mjs <identities.json> <persona> [<persona>...]')
  process.exit(2)
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest()
function base58check(payload) {
  const bytes = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)])
  let n = BigInt(`0x${bytes.toString('hex')}`)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    out = `1${out}`
  }
  return out
}
const wif = (hex) => base58check(Buffer.concat([Buffer.from([0xef]), Buffer.from(hex, 'hex'), Buffer.from([0x01])]))
/** The four parts run.sh types a key in: ceil(length / 4) characters each. */
function parts(value) {
  const size = Math.ceil(value.length / 4)
  return [0, 1, 2, 3].map((i) => value.slice(i * size, (i + 1) * size)).filter(Boolean)
}

const identities = JSON.parse(readFileSync(pool, 'utf8')).identities ?? []
const out = new Set()
for (const index of personas) {
  const persona = identities.find((p) => p.personaIdx === Number(index))
  if (!persona) {
    console.error(`persona ${index} is not in the pool`)
    process.exit(1)
  }
  for (const key of persona.identityKeys ?? []) {
    if (!/^[0-9a-f]{64}$/i.test(key.privateKeyHex ?? '')) continue
    for (const form of [key.privateKeyHex.toLowerCase(), key.privateKeyHex.toUpperCase(), wif(key.privateKeyHex)]) {
      out.add(form)
      for (const part of parts(form)) out.add(part)
    }
  }
}
if (out.size === 0) {
  console.error('no private keys found for these personas')
  process.exit(1)
}
process.stdout.write(`${[...out].join('\n')}\n`)
