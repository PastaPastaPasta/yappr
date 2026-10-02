/**
 * The second persona for the Maestro suite (mobile/e2e): the engine in Node,
 * signed in as one sakura pool persona, behind a loopback HTTP server that
 * Maestro's `runScript` calls (`mobile/e2e/scripts/peer.js`).
 *
 *   YAPPR_SAKURA_IDENTITIES=<identities.json> E2E_PEER_PERSONA=96 \
 *     npx vite-node --config mobile/engine/vitest.config.ts mobile/engine/harness/e2e-peer.ts
 *
 * Routes (JSON bodies, loopback only):
 *   GET  /health           {ready, identityId, handle} once signed in and messages are unlocked
 *   POST /post {text}      publish a post as the peer; answers {id} once confirmed
 *   POST /delete {id}      delete one of the peer's posts; answers once settled
 *   POST /dm/answer {from, expect, reply}
 *                          answers 202 at once, then waits (up to 4 minutes) for a 1:1
 *                          message from `from` reading `expect`, and replies `reply`
 *   GET  /dm/answer?expect=<text>   that job's state: waiting | replied | failed (+ error)
 *
 * Like the write suite, it signs with keyId 2 and unlocks messages with keyId
 * 4, and it never logs key material or message text (identity ids, ticket
 * states and error codes only). Everything it posts is deleted on shutdown.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { loadPoolPersonas } from './pool'

const PERSONA = Number(process.env.E2E_PEER_PERSONA ?? '')
const [HOST, PORT] = (process.env.E2E_PEER_ADDR ?? '127.0.0.1:8790').split(':')
const ANSWER_WAIT_MS = 240_000
const POLL_MS = 4_000

const log = (message: string) => console.error(`[e2e-peer] ${new Date().toISOString()} ${message}`)

if (!Number.isInteger(PERSONA) || PERSONA < 90 || PERSONA > 98) {
  throw new Error('E2E_PEER_PERSONA must be a mobile pool persona, 90-98 (99 holds proof posts and is never written with)')
}
if (HOST !== '127.0.0.1' && HOST !== 'localhost') throw new Error('E2E_PEER_ADDR must be a loopback address')

// The write suite's Node stand-in for the WebView: sakura env, storage shim, `window`.
const { writeSuiteSkipReason, retryQuorum, pollSettled } = await import('../test/contract/write/env')
const skip = writeSuiteSkipReason()
if (skip) throw new Error(`The peer cannot run: ${skip}`)
// The SDK's WASM from the package, as the write suite's setupFiles install it (vite-node runs none).
await import('../test/setup/wasm')
await import('../test/contract/write/setup')
// lib's DM v5 flush listens on `document` (the WebView's); Node has none.
if (typeof document === 'undefined') {
  Object.assign(globalThis, { document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) })
}
const { connectEngine } = await import('../test/contract/engine')
type WriteTicket = Awaited<ReturnType<ReturnType<typeof connectEngine>['api']['writes']['get']>>

const [persona] = loadPoolPersonas(undefined, [PERSONA])

const engine = connectEngine({ timeoutMs: 300_000 })
let ready = false
let handle: string | null = null
const posted = new Set<string>()
const answers = new Map<string, { state: 'waiting' | 'replied' | 'failed'; error?: string }>()

/**
 * Run a write to `confirmed`, as a patient user would: an unconfirmed ticket
 * is checked ("Check again"), and one proved not applied, or refused
 * retryably (sakura's "Quorum not found in cache" while the SDK's quorum list
 * lags), is retried, 5 s apart, up to 4 more steps.
 */
async function settled(ticket: NonNullable<WriteTicket>): Promise<NonNullable<WriteTicket>> {
  let current = await pollSettled(id => engine.api.writes.get(id), ticket.id)
  for (let attempt = 0; attempt < 4 && current.state !== 'confirmed'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5_000))
    if (current.retryable) current = await pollSettled(id => engine.api.writes.get(id), (await engine.api.writes.retry(current.id)).id)
    else if (current.state === 'unconfirmed') current = await engine.api.writes.check(current.id)
    else break
  }
  if (current.state !== 'confirmed') {
    throw new Error(`${ticket.op} ${current.state}${current.error ? `: ${current.error.code}` : ''}`)
  }
  return current
}

async function start(): Promise<void> {
  await engine.api.engine.boot()
  await engine.api.session.signOut()
  const session = await retryQuorum(() => engine.api.session.signInWithKey({ key: persona.keyHex('high') }))
  handle = session.username ?? null
  if ((await engine.api.dm.status()).locked) {
    const unlocked = await engine.api.dm.unlock({ key: persona.keyHex('encryption') })
    if (!unlocked.unlocked) throw new Error('Messages did not unlock with keyId 4')
  }
  for (let waited = 0; !(await engine.api.dm.status()).ready; waited += 500) {
    if (waited >= ANSWER_WAIT_MS) throw new Error('Messages did not load')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  ready = true
  log(`ready as persona ${PERSONA} (${persona.identityId})`)
}

async function answer(from: string, expect: string, reply: string): Promise<void> {
  const deadline = Date.now() + ANSWER_WAIT_MS
  while (Date.now() < deadline) {
    await engine.api.engine.lifecycle('active')
    const conversation = (await engine.api.dm.conversations()).find(c => c.kind === 'direct' && c.peer?.id === from)
    if (conversation) {
      const page = await engine.api.dm.messages(conversation.key)
      if (page.items.some(message => !message.own && message.text === expect)) {
        await engine.api.dm.markRead(conversation.key)
        await settled(await engine.api.dm.send(conversation.key, reply))
        return
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`No message from ${from} within ${ANSWER_WAIT_MS / 1000} s`)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!parsed || typeof parsed !== 'object') throw new Error('The body must be a JSON object')
  return parsed as Record<string, unknown>
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw new Error(`${name} must be a string of 1-500 characters`)
  return value
}

async function route(req: IncomingMessage): Promise<[number, unknown]> {
  const url = new URL(req.url ?? '/', 'http://peer')
  if (req.method === 'GET' && url.pathname === '/health') return [ready ? 200 : 503, { ready, identityId: persona.identityId, handle }]
  if (!ready) return [503, { error: 'not ready' }]
  if (req.method === 'GET' && url.pathname === '/dm/answer') {
    const job = answers.get(url.searchParams.get('expect') ?? '')
    return job ? [200, job] : [404, { error: 'no such job' }]
  }
  if (req.method !== 'POST') return [404, { error: 'not found' }]
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return [415, { error: 'JSON only' }]
  const body = await readJson(req)
  switch (url.pathname) {
    case '/post': {
      const submitted = await engine.api.posts.publish({ parts: [{ text: text(body.text, 'text') }] })
      let ticket = submitted
      try {
        ticket = await settled(submitted)
      } finally {
        // A post that may have landed unconfirmed is still deleted on shutdown.
        const latest = (await engine.api.writes.get(ticket.id).catch(() => null)) ?? ticket
        for (const doc of latest.documents) posted.add(doc.id)
      }
      const id = ticket.documents.find(doc => doc.part === 0)?.id
      if (!id) throw new Error('The post has no document id')
      log(`posted ${id}`)
      return [200, { id }]
    }
    case '/delete': {
      const id = text(body.id, 'id')
      await settled(await engine.api.posts.delete({ id, kind: 'post', ownerId: persona.identityId, rootPostId: null }))
      posted.delete(id)
      log(`deleted ${id}`)
      return [200, { id }]
    }
    case '/dm/answer': {
      const from = text(body.from, 'from')
      const expect = text(body.expect, 'expect')
      const reply = text(body.reply, 'reply')
      answers.set(expect, { state: 'waiting' })
      log(`waiting for a message from ${from}`)
      answer(from, expect, reply).then(
        () => {
          answers.set(expect, { state: 'replied' })
          log(`replied to ${from}`)
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          answers.set(expect, { state: 'failed', error: message })
          log(`answer to ${from} failed: ${message}`)
        },
      )
      return [202, { state: 'waiting' }]
    }
    default:
      return [404, { error: 'not found' }]
  }
}

const server = createServer((req, res) => {
  // Loopback is not enough against web pages: refuse anything a browser could send.
  const host = (req.headers.host ?? '').split(':')[0]
  if (req.headers.origin !== undefined || (host !== '127.0.0.1' && host !== 'localhost')) {
    res.writeHead(403).end()
    return
  }
  route(req).then(
    ([status, payload]) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      log(`${req.method} ${req.url} failed: ${message}`)
      res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
    },
  )
})

async function shutdown(): Promise<void> {
  server.close()
  let failed = 0
  for (const id of posted) {
    await engine.api.posts
      .delete({ id, kind: 'post', ownerId: persona.identityId, rootPostId: null })
      .then(ticket => settled(ticket))
      .then(() => log(`cleaned up ${id}`))
      .catch((error: unknown) => {
        failed++
        log(`cleanup of ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  await engine.api.session.signOut().catch(() => undefined)
  process.exit(failed ? 1 : 0)
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown().catch(() => process.exit(1))
  })
}

server.on('error', (error: Error) => {
  // EADDRINUSE and the like: never leave run.sh talking to whatever else holds the port.
  log(`server error: ${error.message}`)
  process.exit(1)
})
server.listen(Number(PORT), HOST, () => log(`listening on ${HOST}:${PORT}`))
/** Start, again on a failure: sakura's quorum list lags now and then ("Quorum not found in cache"). */
async function startWithRetries(attempts = 10): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start()
    } catch (error) {
      log(`start attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 10_000))
    }
  }
}
startWithRetries().catch(() => process.exit(1))
