/**
 * CLI and HTTP front end of the test-wallet responder (ADR-001 E5.4,
 * EXECUTION.md M3). See mobile/tools/README.md.
 *
 *   node mobile/tools/test-wallet-responder.mjs --uri '<dash-key:…|dash-st:…>' --persona 90
 *   node mobile/tools/test-wallet-responder.mjs --serve 127.0.0.1:8789
 *
 * Output is one JSON line per answer, with ids and key ids only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  ENV_FILE_VAR,
  loadConfig,
  requireKeyExchangeContract,
  requirePoolMatchesNetwork,
  type ResponderConfig,
} from './config'
import { errorMessage } from './errors'
import { connectDevnet, livePorts } from './platform'
import { loadPool, POOL_ENV_VAR, selectPersona, type Pool } from './pool'
import { respond, type RespondResult, type ResponderPorts } from './responder'

/** src/ and dist/ both sit at mobile/tools/<dir>/. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const MAX_BODY_BYTES = 64 * 1024

const USAGE = `Usage:
  test-wallet-responder --uri <dash-key:…|dash-st:…> --persona <idx> [--key-index <n>] [--env-file <path>]
  test-wallet-responder --serve 127.0.0.1:8789 [--env-file <path>]

Env:
  ${POOL_ENV_VAR}  path to the sakura pool identities.json (required)
  ${ENV_FILE_VAR}           variant env file (default: <repo>/.env.devnet)

HTTP: POST /respond {"uri": "...", "persona": 90, "keyIndex"?: 0} → the answer as JSON; GET /health.`

interface Request {
  uri: string
  personaIdx: number
  keyIndex?: number
}

class Responder {
  private ports: Promise<ResponderPorts> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly pool: Pool,
    private readonly config: ResponderConfig,
  ) {}

  /** One request at a time: concurrent writes by one identity would race for nonces. */
  answer(request: Request): Promise<RespondResult> {
    const run = this.queue.then(() => this.answerNow(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async answerNow({ uri, personaIdx, keyIndex }: Request): Promise<RespondResult> {
    const persona = selectPersona(this.pool, personaIdx)
    // Fail before connecting when the answer could not be written anyway.
    if (uri.startsWith('dash-key:')) requireKeyExchangeContract(this.config)
    this.ports ??= connectDevnet(REPO_ROOT, this.config.devnet).then(
      (sdk) => livePorts(sdk, this.config, log),
      (error: unknown) => {
        this.ports = undefined
        throw error
      },
    )
    return respond({ uri, persona, keyIndex }, await this.ports)
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      uri: { type: 'string' },
      persona: { type: 'string' },
      'key-index': { type: 'string' },
      serve: { type: 'string' },
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help || (!values.serve && !values.uri)) {
    console.log(USAGE)
    return values.help ? 0 : 2
  }

  try {
    const envFile = resolve(values['env-file'] ?? process.env[ENV_FILE_VAR] ?? resolve(REPO_ROOT, '.env.devnet'))
    const config = loadConfig(envFile)
    const pool = loadPool()
    requirePoolMatchesNetwork(pool, config)
    log(`devnet ${config.devnet.devnetName} from ${envFile}; key-exchange contract ${config.keyExchangeContractId ?? '(unset)'}`)
    const responder = new Responder(pool, config)

    if (values.serve) {
      await serve(responder, values.serve)
      return 0
    }
    if (values.persona === undefined) throw new Error('--persona <idx> is required with --uri')
    const result = await responder.answer({
      uri: values.uri!,
      personaIdx: parseIndex(values.persona, '--persona'),
      keyIndex: values['key-index'] === undefined ? undefined : parseIndex(values['key-index'], '--key-index'),
    })
    console.log(JSON.stringify(result))
    return 0
  } catch (error) {
    console.error(`test-wallet-responder: ${errorMessage(error)}`)
    return 1
  }
}

async function serve(responder: Responder, address: string): Promise<void> {
  const separator = address.lastIndexOf(':')
  const host = address.slice(0, separator).replace(/^\[|\]$/g, '')
  const port = Number(address.slice(separator + 1))
  if (separator <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--serve expects host:port, got ${address}`)
  }
  // It signs with pool keys for whoever asks: loopback only.
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`--serve binds loopback only (127.0.0.1, ::1, localhost), not ${host}`)

  const server = createServer((req, res) => {
    handle(responder, port, req, res).catch((error: unknown) => reply(res, 500, { error: errorMessage(error) }))
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolveListen())
  })
  log(`listening on http://${address} (POST /respond)`)
  await new Promise<void>((resolveClose) => {
    const stop = () => {
      server.close(() => resolveClose())
      server.closeAllConnections()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

async function handle(responder: Responder, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Loopback binding keeps other machines out, not web pages in a local
  // browser: refuse any request a browser could send cross-site.
  const refusal = browserRefusal(req, port)
  if (refusal) return reply(res, 403, { error: refusal })
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true })
  if (req.method !== 'POST' || req.url !== '/respond') return reply(res, 404, { error: 'POST /respond or GET /health' })

  let request: Request
  try {
    const body = JSON.parse(await readBody(req)) as { uri?: unknown; persona?: unknown; keyIndex?: unknown }
    if (typeof body.uri !== 'string') throw new Error('body.uri must be a string')
    request = {
      uri: body.uri,
      personaIdx: parseIndex(body.persona, 'body.persona'),
      keyIndex: body.keyIndex === undefined ? undefined : parseIndex(body.keyIndex, 'body.keyIndex'),
    }
  } catch (error) {
    return reply(res, 400, { error: errorMessage(error) })
  }

  try {
    const result = await responder.answer(request)
    log(JSON.stringify(result))
    reply(res, 200, result)
  } catch (error) {
    log(`persona ${request.personaIdx}: ${errorMessage(error)}`)
    reply(res, 422, { error: errorMessage(error) })
  }
}

function browserRefusal(req: IncomingMessage, port: number): string | undefined {
  // DNS rebinding: the page's own hostname arrives in Host.
  const match = /^(\[::1\]|[^:]+):(\d+)$/.exec(req.headers.host ?? '')
  if (!match || !LOOPBACK_HOSTS.has(match[1].replace(/^\[|\]$/g, '')) || Number(match[2]) !== port) {
    return 'Host must be a loopback address with the bound port'
  }
  if (req.headers.origin !== undefined) return 'Browser requests (Origin header) are refused'
  // A cross-site "simple" POST cannot be application/json without a CORS
  // preflight, which this server never answers.
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    return 'Content-Type must be application/json'
  }
  return undefined
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function parseIndex(value: unknown, label: string): number {
  let number = NaN
  if (typeof value === 'number') number = value
  else if (typeof value === 'string' && /^\d+$/.test(value)) number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`)
  return number
}

function log(line: string): void {
  console.error(`[responder] ${line}`)
}
