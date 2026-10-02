#!/usr/bin/env node
// Reads the wallet sign-in QR code off the device under test, for the Maestro suite
// (mobile/e2e). Release builds show the dash-key: / dash-st: request only as a QR code
// and a "Copy link" button, never as text (KeyExchangeParts' DevWalletUri is __DEV__
// only), and Maestro can neither read the device clipboard nor decode an image. So
// scripts/respond.js asks this loopback server, which takes a screenshot of the device
// (adb screencap / simctl io), decodes it (Core Image, qr-decode.swift) and returns the
// link, which respond.js hands to the test-wallet responder. The same path works for
// dev clients. run.sh starts one per run (it is bound to one device).
//
//   node mobile/e2e/host/qr-bridge.mjs --platform ios|android --device <udid|serial> --listen 127.0.0.1:8791
//
//   GET /health                    {ok: true} once the decoder is built
//   GET /qr?scheme=dash-key|dash-st  {uri} of the QR code on screen with that scheme,
//                                  404 {error} when none shows within a few tries
//
// A QR code is not secret (anyone who sees the screen can scan it), and nothing else
// passes through here. macOS only (Core Image), like the iOS simulator.
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
  options: { platform: { type: 'string' }, device: { type: 'string' }, listen: { type: 'string' } },
})
const { platform, device } = values
if (platform !== 'ios' && platform !== 'android') throw new Error('--platform must be ios or android')
if (!device) throw new Error('--device is required')
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

const server = createServer((req, res) => {
  // Loopback only, and never for a web page in a local browser (DNS rebinding, cross-site requests).
  if (req.headers.origin !== undefined || req.headers.host !== `${host}:${port}`) {
    return reply(res, 403, { error: 'loopback requests only' })
  }
  const url = new URL(req.url ?? '/', `http://${host}:${port}`)
  if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true })
  if (req.method !== 'GET' || url.pathname !== '/qr') return reply(res, 404, { error: 'GET /qr?scheme= or GET /health' })
  const scheme = url.searchParams.get('scheme') ?? ''
  if (!SCHEMES.has(scheme)) return reply(res, 400, { error: 'scheme must be dash-key or dash-st' })
  findLink(scheme).then(
    (uri) => {
      log(`read a ${scheme}: QR code`)
      reply(res, 200, { uri })
    },
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
