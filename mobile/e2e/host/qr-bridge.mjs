#!/usr/bin/env node
// The wallet side of the sign-in for the Maestro suite (mobile/e2e). Release builds show
// the dash-key: / dash-st: request only as a QR code and a "Copy link" button, never as
// text (KeyExchangeParts' DevWalletUri is __DEV__ only), and Maestro can neither read
// the device clipboard nor decode an image. So scripts/respond.js asks this loopback
// server, which takes a screenshot of the device (adb screencap / simctl io), decodes
// the QR code (Core Image, qr-decode.swift) and hands the link to the test-wallet
// responder (mobile/tools), as a wallet scanning it would. The same path works for dev
// clients. run.sh starts one per run (it is bound to one device).
//
//   node mobile/e2e/host/qr-bridge.mjs --platform ios|android --device <udid|serial> \
//     --listen 127.0.0.1:8791 --responder http://127.0.0.1:8789
//
//   GET  /health        {ok: true} once the decoder is built
//   POST /respond {scheme: "dash-key"|"dash-st", persona, keyIndex?}
//        reads the QR code with that scheme off the screen (404 when none shows within a
//        few tries) and answers the responder's reply. When the responder fails on
//        sakura's lag (quorum not in its cache, every DAPI address banned), it waits
//        RETRY_PAUSE_MS before answering 503 {retry: true}, so respond.js can call again
//        without a busy wait (Maestro's JavaScript has no timers).
//
// A QR code is not secret (anyone who sees the screen can scan it), and no key passes
// through here. macOS only (Core Image), like the iOS simulator.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const TRIES = 5
const TRY_GAP_MS = 1500
const SCHEMES = new Set(['dash-key', 'dash-st'])
const RETRY_PAUSE_MS = 15_000
/** The responder's failures that pass once sakura catches up (the SDK bans nodes for a while). */
const TRANSIENT = /Quorum not found|no available addresses|timed? ?out|unavailable|ECONNRESET/i

const log = (message) => console.error(`[qr-bridge] ${new Date().toISOString()} ${message}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const run = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', ...options }, (error, stdout, stderr) => {
      if (error) {
        error.message += `: ${stderr.toString().trim().slice(0, 300)}`
        reject(error)
      } else resolve(stdout)
    })
  })

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    device: { type: 'string' },
    listen: { type: 'string' },
    responder: { type: 'string' },
  },
})
const { platform, device } = values
if (platform !== 'ios' && platform !== 'android') throw new Error('--platform must be ios or android')
if (!device) throw new Error('--device is required')
const responder = new URL(values.responder ?? 'http://127.0.0.1:8789')
if (responder.hostname !== '127.0.0.1' && responder.hostname !== 'localhost') {
  throw new Error('--responder must be a loopback URL')
}
const [host, portText] = (values.listen ?? '127.0.0.1:8791').split(':')
const port = Number(portText)
if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('--listen must be a loopback address')
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--listen expects host:port')
const adb = process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : 'adb'

// The decoder, compiled once per source version (swiftc takes a while on a loaded host).
const source = join(dirname(fileURLToPath(import.meta.url)), 'qr-decode.swift')
const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12)
const cacheDir = join(tmpdir(), 'yappr-e2e')
const decoder = join(cacheDir, `qr-decode-${hash}`)
if (!existsSync(decoder)) {
  mkdirSync(cacheDir, { recursive: true })
  const partial = `${decoder}.${process.pid}`
  await run('xcrun', ['swiftc', '-O', '-o', partial, source])
  await rename(partial, decoder)
}

const work = join(tmpdir(), `yappr-e2e-qr-${process.pid}`)
mkdirSync(work, { recursive: true, mode: 0o700 })
let shots = 0

/** The payloads of every QR code on the device's screen now. */
async function readScreen() {
  const file = join(work, `screen-${++shots}.png`)
  try {
    if (platform === 'android') {
      const png = await run(adb, ['-s', device, 'exec-out', 'screencap', '-p'])
      await writeFile(file, png)
    } else {
      await run('xcrun', ['simctl', 'io', device, 'screenshot', '--type=png', file])
    }
    const out = await run(decoder, [file]).catch(() => Buffer.alloc(0))
    return out.toString().split('\n').map((line) => line.trim()).filter(Boolean)
  } finally {
    rmSync(file, { force: true })
  }
}

async function findLink(scheme) {
  let seen = []
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    seen = await readScreen()
    const uri = seen.find((payload) => payload.startsWith(`${scheme}:`))
    if (uri) return uri
    if (attempt < TRIES) await sleep(TRY_GAP_MS)
  }
  throw Object.assign(new Error(`no ${scheme}: QR code on screen (${seen.length} other QR code(s))`), { status: 404 })
}

const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 10_000) throw new Error('body too large')
  }
  return JSON.parse(body)
}

/** One answer: the link on screen to the responder; a transient failure pauses, then says retry. */
async function respond({ scheme, persona, keyIndex }) {
  if (!SCHEMES.has(scheme)) return [400, { error: 'scheme must be dash-key or dash-st' }]
  const uri = await findLink(scheme)
  log(`read a ${scheme}: QR code`)
  const answer = await fetch(new URL('/respond', responder), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(keyIndex === undefined ? { uri, persona } : { uri, persona, keyIndex }),
  })
  const text = await answer.text()
  if (answer.ok) return [200, JSON.parse(text)]
  if (TRANSIENT.test(text)) {
    log(`the responder answered ${answer.status} (transient): ${text.slice(0, 200)}; pausing before a retry`)
    await sleep(RETRY_PAUSE_MS)
    return [503, { retry: true, error: text }]
  }
  return [answer.status, { error: text }]
}

const server = createServer((req, res) => {
  // Loopback only, and never for a web page in a local browser (DNS rebinding, cross-site requests).
  if (req.headers.origin !== undefined || req.headers.host !== `${host}:${port}`) {
    return reply(res, 403, { error: 'loopback requests only' })
  }
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true })
  if (req.method !== 'POST' || req.url !== '/respond') return reply(res, 404, { error: 'POST /respond or GET /health' })
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    return reply(res, 403, { error: 'Content-Type must be application/json' })
  }
  readBody(req)
    .then(respond)
    .then(
      ([status, body]) => reply(res, status, body),
      (error) => {
        log(error.message)
        reply(res, error.status ?? 500, { error: error.message })
      },
    )
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, host, resolve)
})
log(`listening on http://${host}:${port} for ${platform} ${device}`)
const stop = () => {
  server.close()
  server.closeAllConnections()
  rmSync(work, { recursive: true, force: true })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
