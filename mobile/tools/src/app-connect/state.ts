/**
 * What the test wallet remembers between answers, per (identity, app):
 *
 * - the responses it published and has not deleted: the `loginKeyResponse`
 *   type is indexOnly, so the only way to delete one is to send all three of
 *   its values back, and nothing on chain lists them by owner;
 * - the auth keys of the current grant per CONNECTION_ID, so the next login
 *   from that connection disables them and a renewal can raise their limits.
 *
 * Everything here is public (response values are on chain, key ids and the
 * derivation tag `hash256(appEphPub)` reveal no key): no private key is ever
 * written. The file lives outside the repo, one per devnet.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppConnectKeyBounds } from '../../../../vendor/platform-auth/src/app-connect/types'

export const STATE_FILE_VAR = 'YAPPR_APP_CONNECT_STATE'

/** A published `loginKeyResponse`, hex-encoded. */
export interface StoredResponse {
  appEphemeralPubKeyHash: string
  walletEphemeralPubKey: string
  encryptedPayload: string
  /** The id the SDK reported for the entry (indexOnly: not a primary key, but the delete carries one). */
  documentId?: string
}

export interface GrantedAuthKey {
  keyId: number
  /** Position of the binding in the request that created the key. */
  bindingIndex: number
  /** `hash256(appEphPub)` of that request (hex): with the binding index, re-derives the key. */
  derivationTag: string
  /** The bounds the key was registered with (what a renewal matches). */
  bounds?: AppConnectKeyBounds
}

export interface ConnectionGrant {
  keys: GrantedAuthKey[]
  grantedAt: string
}

export interface AppRecord {
  responses: StoredResponse[]
  /** By CONNECTION_ID (hex). */
  connections: Record<string, ConnectionGrant>
}

export interface GrantStore {
  get(identityId: string, appId: string): AppRecord
  put(identityId: string, appId: string, record: AppRecord): void
}

interface StateFile {
  version: 1
  devnet: string
  records: Record<string, AppRecord>
}

function emptyRecord(): AppRecord {
  return { responses: [], connections: {} }
}

function recordKey(identityId: string, appId: string): string {
  return `${identityId}/${appId}`
}

/** `$XDG_STATE_HOME/yappr-mobile-tools/app-connect-<devnet>.json` (default `~/.local/state`). */
export function defaultStatePath(devnetName: string): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'yappr-mobile-tools', `app-connect-${devnetName}.json`)
}

export function memoryGrantStore(): GrantStore {
  const records = new Map<string, AppRecord>()
  return {
    get: (identityId, appId) => structuredClone(records.get(recordKey(identityId, appId)) ?? emptyRecord()),
    put: (identityId, appId, record) => {
      records.set(recordKey(identityId, appId), structuredClone(record))
    },
  }
}

/**
 * A JSON file, re-read on every call and replaced atomically on every write.
 * The responder answers one request at a time, so there is one writer.
 */
export function fileGrantStore(path: string, devnetName: string): GrantStore {
  function load(): StateFile {
    if (!existsSync(path)) return { version: 1, devnet: devnetName, records: {} }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateFile>
    if (parsed.version !== 1 || typeof parsed.records !== 'object' || parsed.records === null) {
      throw new Error(`${path} is not an App Connect state file (version 1)`)
    }
    if (parsed.devnet !== devnetName) {
      throw new Error(`${path} belongs to devnet ${parsed.devnet ?? '(unset)'}, not ${devnetName}`)
    }
    return parsed as StateFile
  }

  return {
    get(identityId, appId) {
      return load().records[recordKey(identityId, appId)] ?? emptyRecord()
    },
    put(identityId, appId, record) {
      const state = load()
      state.records[recordKey(identityId, appId)] = record
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, path)
    },
  }
}
