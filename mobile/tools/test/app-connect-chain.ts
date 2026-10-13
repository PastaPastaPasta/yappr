/**
 * An in-memory stand-in for the parts of Platform the App Connect responder
 * touches, enforcing the rules that matter here: key ids from max + 1, at most
 * six new and ten disabled keys per update, no key registered twice, limits
 * only on non-MASTER auth keys, no expired key, groups must exist, one
 * response per (request, owner), and an indexOnly delete only with all three
 * values. It also serves the app-side verifier's identity port, so tests run
 * the real `verifyAppConnectCandidate`. `newChain` and `newRequest` set up
 * Yappr's request on it.
 */
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { buildAppConnectUri, type AppConnectRequest } from '../../../vendor/platform-auth/src/app-connect/request'
import {
  KeyPurpose,
  KeySecurityLevel,
  KeyType,
  type AppConnectGroupInfo,
  type AppConnectIdentityKey,
  type AppConnectIdentityPort,
} from '../../../vendor/platform-auth/src/app-connect/types'
import type { AppConnectCandidate } from '../../../vendor/platform-auth/src/app-connect/poller'
import { getYapprPublicKey } from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import type { AppRecord, GrantStore } from '../src/app-connect/state'
import type { AppConnectPorts, ChainContract, ResponseValues } from '../src/app-connect/wallet'
import type { Persona } from '../src/pool'
import { PERSONA_IDXS, testPersona, testPrivateKey } from './fixtures'

const MAX_KEYS_PER_UPDATE = 6
const MAX_KEYS_TO_DISABLE = 10

const id = (byte: number) => new Uint8Array(32).fill(byte)
export const OWNER = bs58.encode(id(0xb1))
export const STRANGER = bs58.encode(id(0xb2))
export const APP_ID = id(0xa1)
export const GROUP_ID = id(0xa2)
export const FOREIGN_GROUP = bs58.encode(id(0xa3))
export const FOREIGN_CONTRACT = id(0xa4)
export const DASHPAY_CONTRACT_ID = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7'
export const CONNECTION_ID = new Uint8Array(16).fill(0x0c)
export const DAY_MS = 24 * 60 * 60 * 1000
export const NOW = 1_791_676_800_000
export const EXPIRES_AT = NOW + 90 * DAY_MS
export const CALLBACK = 'https://yap.pr/connect?r=abc'

/** A consensus refusal, as wasm-sdk reports one (numeric `code`). */
class ConsensusError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

/** The pool's key layout: keyIds 0-4, V0 and unbound. */
const POOL_LAYOUT = [
  { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.MASTER },
  { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.CRITICAL },
  { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.HIGH },
  { purpose: KeyPurpose.TRANSFER, securityLevel: KeySecurityLevel.CRITICAL },
  { purpose: KeyPurpose.ENCRYPTION, securityLevel: KeySecurityLevel.MEDIUM },
]

export function memoryGrantStore(): GrantStore {
  const records = new Map<string, AppRecord>()
  return {
    get: (identityId, appId) => structuredClone(records.get(`${identityId}/${appId}`) ?? { responses: [], connections: {} }),
    put: (identityId, appId, record) => {
      records.set(`${identityId}/${appId}`, structuredClone(record))
    },
  }
}

export class MemoryChain {
  now: number
  readonly identities = new Map<string, AppConnectIdentityKey[]>()
  readonly contracts = new Map<string, ChainContract>()
  readonly groups = new Map<string, string>()
  readonly entries = new Map<string, ResponseValues & { ownerId: string }>()
  readonly spent = new Map<string, bigint>()
  readonly calls: string[] = []
  readonly logs: string[] = []
  readonly grants = memoryGrantStore()

  constructor(now: number) {
    this.now = now
    for (const idx of PERSONA_IDXS) {
      this.identities.set(testPersona(idx).identityId, POOL_LAYOUT.map((layout, keyId) => ({
        id: keyId,
        type: KeyType.ECDSA_SECP256K1,
        ...layout,
        data: getYapprPublicKey(testPrivateKey(keyId, idx)),
      })))
    }
  }

  ports(): AppConnectPorts {
    return {
      grants: this.grants,
      log: (line) => this.logs.push(line),
      now: () => this.now,
      identityKeys: async (identityId) => structuredClone(this.identities.get(identityId) ?? null),
      contract: async (contractId) => this.contracts.get(contractId) ?? null,
      groupOwner: async (groupId) => this.groups.get(groupId) ?? null,
      contractKeys: async (identityId, contractId, purpose) => this.contractKeys(identityId, contractId, purpose),
      remainingBudgets: async (identityId, keyIds) => this.remainingBudgets(identityId, keyIds),
      updateIdentity: async (persona, update) => {
        this.calls.push(`update ${persona.personaIdx} +${update.add.length} -[${update.disable.join(',')}]`)
        const keys = this.keysOf(persona)
        if (update.add.length > MAX_KEYS_PER_UPDATE || update.disable.length > MAX_KEYS_TO_DISABLE) {
          throw new ConsensusError(10501, 'MaxIdentityPublicKeyLimitReachedError')
        }
        for (const keyId of update.disable) {
          const key = keys.find((candidate) => candidate.id === keyId)
          if (!key) throw new ConsensusError(40209, `no key ${keyId}`)
          key.disabledAt = this.now
        }
        let next = Math.max(...keys.map((key) => key.id)) + 1
        return update.add.map((add) => {
          const data = getYapprPublicKey(add.privateKey)
          if (keys.some((key) => bytesToHex(key.data) === bytesToHex(data))) throw new ConsensusError(40206, 'DuplicatedIdentityPublicKeyStateError')
          const limited = add.totalBudget !== undefined || add.expiresAt !== undefined
          if (limited && (add.purpose !== KeyPurpose.AUTHENTICATION || add.securityLevel === KeySecurityLevel.MASTER)) {
            throw new ConsensusError(10536, 'IdentityPublicKeyLimitsNotAllowedError')
          }
          if (add.expiresAt !== undefined && add.expiresAt <= this.now) throw new ConsensusError(40219, 'IdentityPublicKeyAlreadyExpiredError')
          if (add.bounds?.kind === 'contractGroup' && !this.groups.has(add.bounds.groupId)) throw new ConsensusError(40100, 'ContractGroupNotFoundError')
          const key: AppConnectIdentityKey = {
            id: next++,
            type: KeyType.ECDSA_SECP256K1,
            purpose: add.purpose,
            securityLevel: add.securityLevel,
            data,
            bounds: add.bounds,
            totalBudget: add.totalBudget,
            expiresAt: add.expiresAt,
          }
          keys.push(key)
          return key.id
        })
      },
      raiseKeyLimits: async (persona, keyId, limits) => {
        this.calls.push(`limits ${persona.personaIdx} ${keyId}`)
        const key = this.keysOf(persona).find((candidate) => candidate.id === keyId)
        if (!key) throw new ConsensusError(40209, `no key ${keyId}`)
        if (limits.addBudget !== undefined) {
          if (key.totalBudget === undefined) throw new ConsensusError(40220, 'IdentityPublicKeyLimitNotSetError')
          key.totalBudget += limits.addBudget
        }
        if (limits.expiresAt !== undefined) {
          if (key.expiresAt === undefined || limits.expiresAt <= key.expiresAt) throw new ConsensusError(40221, 'IdentityPublicKeyLimitNotRaisedError')
          key.expiresAt = limits.expiresAt
        }
      },
      deleteResponse: async (persona, stored) => {
        this.calls.push(`delete ${persona.personaIdx}`)
        const entryId = `${stored.appEphemeralPubKeyHash}/${persona.identityId}`
        const entry = this.entries.get(entryId)
        if (!entry || bytesToHex(entry.walletEphemeralPubKey) !== stored.walletEphemeralPubKey
          || bytesToHex(entry.encryptedPayload) !== stored.encryptedPayload) {
          throw new ConsensusError(40101, 'DocumentNotFoundError')
        }
        this.entries.delete(entryId)
      },
      createResponse: async (persona, values) => {
        this.calls.push(`create ${persona.personaIdx}`)
        const entryId = `${bytesToHex(values.appEphemeralPubKeyHash)}/${persona.identityId}`
        if (this.entries.has(entryId)) throw new ConsensusError(40105, 'DuplicateUniqueIndexError')
        this.entries.set(entryId, { ...values, ownerId: persona.identityId })
        return { documentId: bs58.encode(values.appEphemeralPubKeyHash), confirmed: true }
      },
    }
  }

  /** The verifier's view of the same chain. */
  identityPort(): AppConnectIdentityPort {
    return {
      getIdentityFresh: async (identityId) => {
        const keys = this.identities.get(identityId)
        return keys ? { id: identityId, publicKeys: structuredClone(keys) } : null
      },
      remainingBudgets: async (identityId, keyIds) => this.remainingBudgets(identityId, keyIds),
      contractKeys: async (identityId, contractId, purpose) => this.contractKeys(identityId, contractId, purpose),
      groupInfo: async (groupId): Promise<AppConnectGroupInfo | null> => {
        const ownerId = this.groups.get(groupId)
        return ownerId ? { ownerId, adminIds: [], members: [] } : null
      },
    }
  }

  /** The app's poll: every response to a request, by owner. */
  candidates(requestHash: Uint8Array): AppConnectCandidate[] {
    return [...this.entries.values()]
      .filter((entry) => bytesToHex(entry.appEphemeralPubKeyHash) === bytesToHex(requestHash))
      .map(({ ownerId, walletEphemeralPubKey, encryptedPayload }) => ({ ownerId, walletEphemeralPubKey, encryptedPayload }))
      .sort((a, b) => (a.ownerId < b.ownerId ? -1 : 1))
  }

  keysOf(persona: Persona): AppConnectIdentityKey[] {
    const keys = this.identities.get(persona.identityId)
    if (!keys) throw new Error(`no identity ${persona.identityId}`)
    return keys
  }

  /** Credits a test says a key has spent: remaining = total − spent. */
  spend(persona: Persona, keyId: number, credits: bigint): void {
    this.spent.set(`${persona.identityId}/${keyId}`, (this.spent.get(`${persona.identityId}/${keyId}`) ?? 0n) + credits)
  }

  private remainingBudgets(identityId: string, keyIds: number[]): Map<number, bigint | undefined> {
    const keys = this.identities.get(identityId) ?? []
    return new Map(keyIds.map((keyId) => {
      const total = keys.find((key) => key.id === keyId)?.totalBudget
      return [keyId, total === undefined ? undefined : total - (this.spent.get(`${identityId}/${keyId}`) ?? 0n)]
    }))
  }

  /**
   * Platform's current-key pointer: the newest key bound to the contract with that purpose. Disabling
   * it does not move the pointer back (rs-drive refreshes the reference without rewriting it).
   */
  private contractKeys(identityId: string, contractId: string, purpose: number): AppConnectIdentityKey[] {
    const matching = (this.identities.get(identityId) ?? []).filter((key) =>
      key.purpose === purpose && key.bounds?.kind === 'singleContract' && key.bounds.contractId === contractId)
    return matching.length === 0 ? [] : [structuredClone(matching[matching.length - 1])]
  }
}

/** A chain with Yappr's anchor (owned by OWNER, opted in to encryption keys), its group, DashPay and a stranger's group and contract. */
export function newChain(now = NOW): MemoryChain {
  const chain = new MemoryChain(now)
  chain.contracts.set(bs58.encode(APP_ID), { ownerId: OWNER, requiresIdentityEncryptionBoundedKey: 2 })
  chain.contracts.set(DASHPAY_CONTRACT_ID, { ownerId: '11111111111111111111111111111111' })
  chain.contracts.set(bs58.encode(FOREIGN_CONTRACT), { ownerId: STRANGER })
  chain.groups.set(bs58.encode(GROUP_ID), OWNER)
  chain.groups.set(FOREIGN_GROUP, STRANGER)
  return chain
}

/** Yappr's request (docs/APP_CONNECT_PROFILE.md "Yappr's request") with a fresh app key. */
export function newRequest(overrides: Partial<AppConnectRequest> = {}, callbackUrl: string | undefined = CALLBACK) {
  const appPrivateKey = secp256k1.utils.randomSecretKey()
  const request: AppConnectRequest = {
    appEphemeralPubKey: getYapprPublicKey(appPrivateKey),
    appId: APP_ID,
    label: 'Yappr',
    authBindings: [
      { kind: 'contractGroup', id: GROUP_ID, securityLevel: KeySecurityLevel.CRITICAL, totalBudget: 50_000_000_000n, expiresAt: EXPIRES_AT },
      {
        kind: 'documentType',
        id: bs58.decode(DASHPAY_CONTRACT_ID),
        documentTypeName: 'profile',
        securityLevel: KeySecurityLevel.HIGH,
        totalBudget: 1_000_000_000n,
        expiresAt: EXPIRES_AT,
      },
    ],
    encBindings: [{ contractId: APP_ID, purpose: KeyPurpose.ENCRYPTION }],
    createdAt: NOW - 5_000,
    connectionId: CONNECTION_ID,
    ...overrides,
  }
  return { request, appPrivateKey, uri: buildAppConnectUri(request, 'devnet', callbackUrl) }
}
