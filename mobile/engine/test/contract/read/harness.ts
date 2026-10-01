/**
 * Shared setup for the read contract suite (ENGINE §12.3): the engine API
 * from source, in Node, through the same dispatcher + client + codec the
 * WebView uses (an in-process transport replaces the bridge). Read only and
 * unauthenticated.
 *
 * One suite, per variant: `ENGINE_VARIANT=testnet` (default; the production
 * yap.pr contracts, topology v2) or `devnet` (sakura). The devnet run skips
 * with a reason until its contracts are published (`ENGINE_DEVNET_READY=1`).
 *
 * Every call made through `timed` is recorded with its wall time into
 * `$EVIDENCE_DIR/contract-read-<variant>/<file>.json` (default
 * `test-results/`), so the Rust engine can be compared later (ENGINE §13).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { createEngineApi, type CapabilitiesDTO, type EngineApi, type PostDTO } from '../../../src/api'
import { createDispatcher } from '../../../src/rpc/dispatcher'
import { createEngineClient } from '../../../src/rpc/client'
import { createInProcessPair } from '../../../src/rpc/transport'
import { validate, type Check } from '../../../src/dto/validate'

export const VARIANT = process.env.ENGINE_VARIANT === 'devnet' ? 'devnet' : 'testnet'

export const EXPECTED = {
  testnet: { network: 'testnet', topology: 'v2', social: '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9' },
  devnet: { network: 'devnet', topology: process.env.NEXT_PUBLIC_CONTRACT_TOPOLOGY, social: process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID },
}[VARIANT]

const SKIP_REASON = VARIANT === 'devnet' && process.env.ENGINE_DEVNET_READY !== '1'
  ? 'devnet (sakura) contracts are not published yet; set ENGINE_DEVNET_READY=1 once W-SAKURA lands'
  : null

const [hostSide, engineSide] = createInProcessPair()
createDispatcher({ api: createEngineApi(), transport: engineSide }).hello({ bundleHash: 'node' })
const client = createEngineClient<EngineApi>(hostSide, { timeoutMs: 120_000 })
export const engine = client.api

interface Timing { method: string; ms: number; note?: string }
const timings: Timing[] = []

/** Run one engine call, recording its wall time under `method`. */
export async function timed<T>(method: string, call: () => Promise<T>, note?: string): Promise<T> {
  const started = performance.now()
  const value = await call()
  timings.push({ method, ms: Math.round(performance.now() - started), ...(note ? { note } : {}) })
  return value
}

/** Fail with every shape problem at once, not just the first. */
export function expectValid(check: Check, value: unknown, label = 'dto'): void {
  expect(validate(check, value, label)).toEqual([])
}

/**
 * `describe` for one API module: boots the engine once per file and writes the
 * file's timings at the end. Skipped, with the reason, where the variant
 * cannot run yet.
 */
export function describeRead(name: string, file: string, body: () => void): void {
  describe.skipIf(SKIP_REASON !== null)(`${name} on ${VARIANT}${SKIP_REASON ? ` (skipped: ${SKIP_REASON})` : ''}`, () => {
    beforeAll(async () => {
      await client.ready
      await timed('engine.boot', () => engine.engine.boot())
    })
    afterAll(() => {
      const dir = path.join(process.env.EVIDENCE_DIR ?? path.resolve(__dirname, '../../../test-results'), `contract-read-${VARIANT}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, `${file}.json`), `${JSON.stringify({ variant: VARIANT, at: new Date().toISOString(), timings }, null, 2)}\n`)
    })
    body()
  })
}

let firstPage: Promise<PostDTO[]> | null = null

/** The first For You page, read once per file: the samples other tests start from. */
export function sampleFeed(): Promise<PostDTO[]> {
  firstPage ??= engine.feed.home({ tab: 'forYou' }).then(page => page.items)
  return firstPage
}

/** A sample author with a DPNS name. */
export async function namedAuthor(): Promise<{ id: string; username: string }> {
  const named = (await sampleFeed()).find(post => post.author.username)?.author
  if (!named?.username) throw new Error('no first-page author has a DPNS name')
  return { id: named.id, username: named.username }
}

let caps: Promise<CapabilitiesDTO> | null = null

/** The variant's topology capabilities, read once per file. */
export function capabilities(): Promise<CapabilitiesDTO> {
  caps ??= engine.engine.info().then(info => info.capabilities)
  return caps
}

/** The call rejects with this engine error code. */
export async function expectCode(call: Promise<unknown>, code: string): Promise<void> {
  await expect(call).rejects.toMatchObject({ code })
}

/** One more than the batch reads' cap of 100. */
export const tooMany = <T>(make: (index: number) => T): T[] => Array.from({ length: 101 }, (_, index) => make(index))
