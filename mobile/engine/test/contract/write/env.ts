/**
 * Where the write suite runs, and why it skips. Writes go to sakura pool
 * identities only (ADR-001 E6); never testnet.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { poolUnavailableReason } from '../../../harness/pool'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** `.env.devnet`'s NEXT_PUBLIC_* values (KEY=VALUE lines, `#` comments, optional quotes), as build.mjs reads them. */
export function devnetEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of readFileSync(path.join(root, '.env.devnet'), 'utf8').split('\n')) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    if (!line || line.startsWith('#') || eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (key.startsWith('NEXT_PUBLIC_')) env[key] = value
  }
  return env
}

/** Poll a ticket until it leaves `pending` (every 500 ms, up to 2 minutes). */
export async function pollSettled<T extends { state: string }>(get: (id: string) => T | null | Promise<T | null>, ticketId: string): Promise<T> {
  for (let i = 0; i < 240; i++) {
    const ticket = await get(ticketId)
    if (ticket && ticket.state !== 'pending') return ticket
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`ticket ${ticketId} still pending after 120 s`)
}

/**
 * The SDK's quorum keys are fetched once, when it is built, and sakura forms
 * a quorum every ~4 minutes, so a proof signed by one newer than the SDK
 * fails "Quorum not found in cache" until lib rebuilds the SDK. The engine's
 * read modules retry that once themselves (src/api/stale-quorum.ts); session
 * calls do not. Only that failure is retried (3 times, 5 s apart); anything
 * else throws.
 */
export async function retryQuorum<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt >= 3 || !isQuorumMiss(error)) throw error
      await new Promise(resolve => setTimeout(resolve, 5_000))
    }
  }
}

export const isQuorumMiss = (error: unknown): boolean =>
  /Quorum not found in cache/i.test(error instanceof Error ? `${error.message} ${(error as { stderr?: unknown }).stderr ?? ''}` : String(error))

/** Why the sakura write suite cannot run here, or null when it can. */
export function writeSuiteSkipReason(): string | null {
  const devnet = devnetEnv().NEXT_PUBLIC_DEVNET_NAME ?? '(none)'
  if (!devnet.startsWith('sakura')) {
    return `W-SAKURA has not landed: .env.devnet names devnet ${devnet}, and sakura has no Yappr contracts yet`
  }
  return poolUnavailableReason()
}
