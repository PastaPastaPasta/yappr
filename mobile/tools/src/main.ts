/**
 * CLI and HTTP front end of the test-wallet responder (ADR-001 E5.4,
 * EXECUTION.md M3). See mobile/tools/README.md.
 *
 *   node mobile/tools/test-wallet-responder.mjs --uri '<dash-key:…|dash-st:…>' --persona 90 [--fault <f>]…
 *   node mobile/tools/test-wallet-responder.mjs --revoke --persona 90 --app-id <id> [--connection-id <hex>]
 *   node mobile/tools/test-wallet-responder.mjs --serve 127.0.0.1:8789
 *
 * Output is one JSON line per answer, with ids and key ids only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ensureInitialized } from '@dashevo/evo-sdk'
import { decodeYapprContractId } from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import {
  ENV_FILE_VAR,
  loadConfig,
  requireKeyExchangeContract,
  requirePoolMatchesNetwork,
  responderNetwork,
  type ResponderConfig,
} from './config'
import { errorMessage } from './errors'
import { connectNetwork, livePorts } from './platform'
import { loadPool, POOL_ENV_VAR, selectPersona, type Pool } from './pool'
import { respond, type RespondResult, type ResponderPorts } from './responder'
import { FAULT_NAMES, parseFaults, type AppConnectFaults } from './app-connect/faults'
import { liveAppConnectPorts } from './app-connect/platform'
import { defaultStatePath, fileGrantStore, STATE_FILE_VAR, type GrantStore } from './app-connect/state'
import {
  AppConnectRefusal,
  isAppConnectUri,
  revokeAppConnect,
  type AppConnectPorts,
  type RevokeResult,
} from './app-connect/wallet'

/** src/ and dist/ both sit at mobile/tools/<dir>/. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const MAX_BODY_BYTES = 64 * 1024
/** The mobile reservation (ENGINE.md §12.3): the default spam personas. */
const MOBILE_PERSONAS = Array.from({ length: 10 }, (_, index) => 90 + index)

const USAGE = `Usage:
  test-wallet-responder --uri <dashpay://connect…|dash-key:…|dash-st:…> --persona <idx> [--key-index <n>] [--env-file <path>]
      App Connect (dashpay://connect or dash-key: v=2) only:
      [--fault <flag>]… [--other-persona <idx>] [--spam-personas <list, e.g. 91-99>] [--state-file <path>]
  test-wallet-responder --revoke --persona <idx> --app-id <base58> [--connection-id <hex>] [--state-file <path>]
  test-wallet-responder --serve 127.0.0.1:8789 [--env-file <path>] [--state-file <path>]

Fault flags: ${FAULT_NAMES.join(', ')}

Env:
  ${POOL_ENV_VAR}  path to the sakura pool identities.json (required)
  ${ENV_FILE_VAR}           variant env file (default: <repo>/.env.devnet)
  ${STATE_FILE_VAR}  App Connect grant state (default: ~/.local/state/yappr-mobile-tools/app-connect-<devnet>.json)

HTTP:
  POST /respond {"uri": "...", "persona": 90, "keyIndex"?: 0, "faults"?: ["budget=1000"], "otherPersona"?: 91, "spamPersonas"?: [92]}
  POST /revoke  {"persona": 90, "appId": "...", "connectionId"?: "<hex>"}
  GET  /health`

interface Request {
  uri: string
  personaIdx: number
  keyIndex?: number
  faults?: AppConnectFaults
  otherPersonaIdx?: number
  spamPersonaIdxs?: number[]
}

interface Revoke {
  personaIdx: number
  appId: string
  connectionId?: string
}

class Responder {
  private ports: Promise<ResponderPorts & { appConnect: AppConnectPorts }> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly pool: Pool,
    private readonly config: ResponderConfig,
    private readonly grants: GrantStore,
  ) {}

  /** One request at a time: concurrent writes by one identity would race for nonces. */
  answer(request: Request): Promise<RespondResult> {
    return this.enqueue(() => this.answerNow(request))
  }

  revoke(request: Revoke): Promise<RevokeResult> {
    return this.enqueue(async () => {
      const ports = await this.connect()
      return revokeAppConnect({
        persona: selectPersona(this.pool, request.personaIdx),
        appId: request.appId,
        connectionId: request.connectionId,
      }, ports.appConnect)
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private connect(): Promise<ResponderPorts & { appConnect: AppConnectPorts }> {
    this.ports ??= connectNetwork(REPO_ROOT, this.config).then(
      (sdk) => ({ ...livePorts(sdk, this.config, log), appConnect: liveAppConnectPorts(sdk, this.grants, log) }),
      (error: unknown) => {
        this.ports = undefined
        throw error
      },
    )
    return this.ports
  }

  private async answerNow(request: Request): Promise<RespondResult> {
    const { uri } = request
    const appConnect = isAppConnectUri(uri)
    // Everything that can be refused offline is, before connecting.
    const persona = selectPersona(this.pool, request.personaIdx)
    if (uri.startsWith('dash-key:') && !appConnect) requireKeyExchangeContract(this.config)
    if (appConnect && request.keyIndex !== undefined) throw new Error('keyIndex applies to legacy (v=1) requests only')
    if (!appConnect && (request.faults || request.otherPersonaIdx !== undefined || request.spamPersonaIdxs)) {
      throw new Error('Fault flags apply to App Connect (v=2) requests only')
    }
    const spamIdxs = request.spamPersonaIdxs ?? (request.faults?.spam ? MOBILE_PERSONAS : undefined)
    return respond({
      uri,
      network: this.config.network,
      persona,
      keyIndex: request.keyIndex,
      faults: request.faults,
      otherPersona: request.otherPersonaIdx === undefined ? undefined : selectPersona(this.pool, request.otherPersonaIdx),
      // The wallet excludes the answering personas itself; missing pool entries are skipped here.
      spamPersonas: spamIdxs
        ?.filter((idx) => this.pool.personas.some((entry) => entry.personaIdx === idx))
        .map((idx) => selectPersona(this.pool, idx)),
    }, await this.connect())
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      uri: { type: 'string' },
      persona: { type: 'string' },
      'key-index': { type: 'string' },
      fault: { type: 'string', multiple: true },
      'other-persona': { type: 'string' },
      'spam-personas': { type: 'string' },
      revoke: { type: 'boolean' },
      'app-id': { type: 'string' },
      'connection-id': { type: 'string' },
      'state-file': { type: 'string' },
      serve: { type: 'string' },
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  const modes = [values.serve !== undefined, values.uri !== undefined, values.revoke === true].filter(Boolean).length
  if (values.help || modes !== 1) {
    if (modes > 1) console.error('test-wallet-responder: --uri, --revoke and --serve exclude each other')
    console.log(USAGE)
    return values.help ? 0 : 2
  }

  try {
    const envFile = resolve(values['env-file'] ?? process.env[ENV_FILE_VAR] ?? resolve(REPO_ROOT, '.env.devnet'))
    const config = loadConfig(envFile)
    const pool = loadPool()
    requirePoolMatchesNetwork(pool, config)
    // Seeded personas derive their App Connect keys on the SDK's wasm (app-connect/derive.ts).
    if (pool.mnemonic) await ensureInitialized()
    const stateNamespace = config.network === 'testnet' ? 'network-testnet' : config.devnet.devnetName
    const statePath = resolve(values['state-file'] ?? process.env[STATE_FILE_VAR] ?? defaultStatePath(stateNamespace))
    log(`${responderNetwork(config)} from ${envFile}; key-exchange contract ${config.keyExchangeContractId ?? '(unset)'}; App Connect state ${statePath}`)
    const responder = new Responder(pool, config, fileGrantStore(statePath, stateNamespace))

    if (values.serve) {
      await serve(responder, values.serve)
      return 0
    }
    if (values.persona === undefined) throw new Error('--persona <idx> is required')
    const personaIdx = parseIndex(values.persona, '--persona')
    if (values.revoke) {
      if (values['app-id'] === undefined) throw new Error('--revoke needs --app-id <base58>')
      const result = await responder.revoke({
        personaIdx,
        appId: parseAppId(values['app-id'], '--app-id'),
        connectionId: values['connection-id'] === undefined ? undefined : parseConnectionId(values['connection-id'], '--connection-id'),
      })
      console.log(JSON.stringify(result))
      return 0
    }
    const result = await responder.answer({
      uri: values.uri!,
      personaIdx,
      keyIndex: values['key-index'] === undefined ? undefined : parseIndex(values['key-index'], '--key-index'),
      faults: values.fault === undefined ? undefined : parseFaults(values.fault),
      otherPersonaIdx: values['other-persona'] === undefined ? undefined : parseIndex(values['other-persona'], '--other-persona'),
      spamPersonaIdxs: values['spam-personas'] === undefined ? undefined : parseIndexList(values['spam-personas']),
    })
    console.log(JSON.stringify(result))
    return 0
  } catch (error) {
    if (error instanceof AppConnectRefusal) console.log(JSON.stringify(refusalBody(error)))
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
  log(`listening on http://${address} (POST /respond, POST /revoke)`)
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
  const route = req.method === 'POST' ? req.url : undefined
  if (route !== '/respond' && route !== '/revoke') return reply(res, 404, { error: 'POST /respond, POST /revoke or GET /health' })

  let run: () => Promise<unknown>
  let personaIdx: number
  try {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    personaIdx = parseIndex(body.persona, 'body.persona')
    if (route === '/revoke') {
      const request: Revoke = {
        personaIdx,
        appId: parseAppId(body.appId, 'body.appId'),
        connectionId: body.connectionId === undefined ? undefined : parseConnectionId(body.connectionId, 'body.connectionId'),
      }
      run = () => responder.revoke(request)
    } else {
      if (typeof body.uri !== 'string') throw new Error('body.uri must be a string')
      const request: Request = {
        uri: body.uri,
        personaIdx,
        keyIndex: body.keyIndex === undefined ? undefined : parseIndex(body.keyIndex, 'body.keyIndex'),
        faults: body.faults === undefined ? undefined : parseFaults(parseStringList(body.faults, 'body.faults')),
        otherPersonaIdx: body.otherPersona === undefined ? undefined : parseIndex(body.otherPersona, 'body.otherPersona'),
        spamPersonaIdxs: body.spamPersonas === undefined ? undefined : parseIndexArray(body.spamPersonas, 'body.spamPersonas'),
      }
      run = () => responder.answer(request)
    }
  } catch (error) {
    return reply(res, 400, { error: errorMessage(error) })
  }

  try {
    const result = await run()
    log(JSON.stringify(result))
    reply(res, 200, result)
  } catch (error) {
    log(`persona ${personaIdx}: ${errorMessage(error)}`)
    reply(res, 422, error instanceof AppConnectRefusal ? refusalBody(error) : { error: errorMessage(error) })
  }
}

/** A refused App Connect request: the profile's `ac=` status and the callback a test can open. */
function refusalBody(refusal: AppConnectRefusal) {
  return { error: refusal.message, ac: refusal.status, callbackUrl: refusal.callbackUrl }
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

function parseIndexArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of persona indexes`)
  return value.map((entry) => parseIndex(entry, label))
}

/** `91-99,80` → [91, …, 99, 80]. */
function parseIndexList(value: string): number[] {
  return value.split(',').flatMap((part) => {
    const range = /^(\d+)-(\d+)$/.exec(part.trim())
    if (!range) return [parseIndex(part.trim(), '--spam-personas')]
    const [from, to] = [Number(range[1]), Number(range[2])]
    if (to < from || to - from > 200) throw new Error(`--spam-personas range ${part} is not ascending or too wide`)
    return Array.from({ length: to - from + 1 }, (_, index) => from + index)
  })
}

function parseStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${label} must be an array of strings`)
  return value as string[]
}

function parseAppId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a base58 contract id`)
  decodeYapprContractId(value)
  return value
}

function parseConnectionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Error(`${label} must be 16 bytes of lowercase hex`)
  return value
}

function log(line: string): void {
  console.error(`[responder] ${line}`)
}
