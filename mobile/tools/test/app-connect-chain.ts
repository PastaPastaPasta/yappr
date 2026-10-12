/**
 * An in-memory stand-in for the parts of Platform the App Connect responder
 * touches, enforcing the rules that matter here: key ids from max + 1, at most
 * six new keys per update, limits only on non-MASTER auth keys, no expired
 * key, groups must exist, one response per (request, owner), and an indexOnly
 * delete only with all three values. It also serves the app-side verifier's
 * identity port, so tests run the real `verifyAppConnectCandidate`.
 */
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  KeyPurpose,
  KeySecurityLevel,
  KeyType,
  type AppConnectGroupInfo,
  type AppConnectIdentityKey,
  type AppConnectIdentityPort,
} from '../../../vendor/platform-auth/src/app-connect/types'
import type { AppConnectCandidate } from '../../../vendor/platform-auth/src/app-connect/poller'
import { memoryGrantStore } from '../src/app-connect/state'
import type { AppConnectPorts, ChainContract, ResponseValues } from '../src/app-connect/wallet'
import type { Persona } from '../src/pool'
import { PERSONA_IDXS, testPersona } from './fixtures'

const MAX_KEYS_PER_UPDATE = 6

interface StoredEntry extends ResponseValues {
  ownerId: string
}

export class MemoryChain {
  now: number
  readonly identities = new Map<string, AppConnectIdentityKey[]>()
  readonly contracts = new Map<string, ChainContract>()
  readonly groups = new Map<string, string>()
  readonly entries = new Map<string, StoredEntry>()
  readonly budgets = new Map<string, bigint>()
  readonly calls: string[] = []
  readonly logs: string[] = []
  readonly grants = memoryGrantStore()

  constructor(now: number) {
    this.now = now
    // Every pool persona exists with its pool key layout (keys 0-4, V0, unbound).
    for (const idx of PERSONA_IDXS) {
      const persona = testPersona(idx)
      this.identities.set(persona.identityId, (['master', 'critical', 'high'] as const).map((role, id) => ({
        id,
        type: KeyType.ECDSA_SECP256K1,
        purpose: KeyPurpose.AUTHENTICATION,
        securityLevel: id === 0 ? KeySecurityLevel.MASTER : id === 1 ? KeySecurityLevel.CRITICAL : KeySecurityLevel.HIGH,
        data: persona.key(role).publicKey,
      })))
    }
  }

  ports(): AppConnectPorts {
    return {
      grants: this.grants,
      log: (line) => this.logs.push(line),
      now: () => this.now,
      identityKeys: async (id) => structuredClone(this.identities.get(id) ?? null),
      contract: async (id) => this.contracts.get(id) ?? null,
      groupOwner: async (id) => this.groups.get(id) ?? null,
      contractKeys: async (identityId, contractId, purpose) => this.contractKeys(identityId, contractId, purpose),
      updateIdentity: async (persona, update) => {
        this.calls.push(`update ${persona.personaIdx} +${update.add.length} -[${update.disable.join(',')}]`)
        const keys = this.requireIdentity(persona)
        if (update.add.length > MAX_KEYS_PER_UPDATE) throw new Error('too many keys')
        for (const id of update.disable) {
          const key = keys.find((candidate) => candidate.id === id)
          if (!key) throw new Error(`no key ${id}`)
          key.disabledAt = this.now
        }
        let next = Math.max(...keys.map((key) => key.id)) + 1
        return update.add.map((add) => {
          const limited = add.totalBudget !== undefined || add.expiresAt !== undefined
          if (limited && (add.purpose !== KeyPurpose.AUTHENTICATION || add.securityLevel === KeySecurityLevel.MASTER)) {
            throw new Error('IdentityPublicKeyLimitsNotAllowedError')
          }
          if (add.expiresAt !== undefined && add.expiresAt <= this.now) throw new Error('IdentityPublicKeyAlreadyExpiredError')
          if (add.bounds?.kind === 'contractGroup' && !this.groups.has(add.bounds.groupId)) throw new Error('ContractGroupNotFoundError')
          const key: AppConnectIdentityKey = {
            id: next++,
            type: KeyType.ECDSA_SECP256K1,
            purpose: add.purpose,
            securityLevel: add.securityLevel,
            data: secp256k1.getPublicKey(add.privateKey, true),
            bounds: add.bounds,
            totalBudget: add.totalBudget,
            expiresAt: add.expiresAt,
          }
          keys.push(key)
          if (add.totalBudget !== undefined) this.budgets.set(`${persona.identityId}/${key.id}`, add.totalBudget)
          return key.id
        })
      },
      raiseKeyLimits: async (persona, keyId, limits) => {
        this.calls.push(`limits ${persona.personaIdx} ${keyId}`)
        const key = this.requireIdentity(persona).find((candidate) => candidate.id === keyId)
        if (!key) throw new Error(`no key ${keyId}`)
        if (limits.addBudget !== undefined) {
          if (key.totalBudget === undefined) throw new Error('IdentityPublicKeyLimitNotSetError')
          key.totalBudget += limits.addBudget
          const budgetKey = `${persona.identityId}/${keyId}`
          this.budgets.set(budgetKey, (this.budgets.get(budgetKey) ?? 0n) + limits.addBudget)
        }
        if (limits.expiresAt !== undefined) {
          if (key.expiresAt === undefined || limits.expiresAt <= key.expiresAt) throw new Error('IdentityPublicKeyLimitNotRaisedError')
          key.expiresAt = limits.expiresAt
        }
      },
      deleteResponse: async (persona, stored) => {
        this.calls.push(`delete ${persona.personaIdx}`)
        const id = entryId(hexToBytes(stored.appEphemeralPubKeyHash), persona.identityId)
        const entry = this.entries.get(id)
        if (!entry || bytesToHex(entry.walletEphemeralPubKey) !== stored.walletEphemeralPubKey
          || bytesToHex(entry.encryptedPayload) !== stored.encryptedPayload) {
          throw new Error('DocumentNotFoundError')
        }
        this.entries.delete(id)
      },
      createResponse: async (persona, values) => {
        this.calls.push(`create ${persona.personaIdx}`)
        const id = entryId(values.appEphemeralPubKeyHash, persona.identityId)
        if (this.entries.has(id)) throw new Error('DuplicateUniqueIndexError')
        this.entries.set(id, { ...values, ownerId: persona.identityId })
        return { documentId: bs58.encode(hexToBytes(id.slice(0, 64))), confirmed: true }
      },
    }
  }

  /** The verifier's view of the same chain. */
  identityPort(): AppConnectIdentityPort {
    return {
      getIdentityFresh: async (id) => {
        const keys = this.identities.get(id)
        return keys ? { id, publicKeys: structuredClone(keys) } : null
      },
      remainingBudgets: async (id, keyIds) => new Map(keyIds.map((keyId) => [keyId, this.budgets.get(`${id}/${keyId}`)])),
      contractKeys: async (id, contractId, purpose) => this.contractKeys(id, contractId, purpose),
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
    return this.requireIdentity(persona)
  }

  /** Platform's current-key pointer: the newest live key bound to the contract with that purpose. */
  private contractKeys(identityId: string, contractId: string, purpose: number): AppConnectIdentityKey[] {
    const matching = (this.identities.get(identityId) ?? []).filter((key) =>
      key.purpose === purpose && key.disabledAt === undefined
      && key.bounds?.kind === 'singleContract' && key.bounds.contractId === contractId)
    return matching.length === 0 ? [] : [structuredClone(matching[matching.length - 1])]
  }

  private requireIdentity(persona: Persona): AppConnectIdentityKey[] {
    const keys = this.identities.get(persona.identityId)
    if (!keys) throw new Error(`no identity ${persona.identityId}`)
    return keys
  }
}

function entryId(requestHash: Uint8Array, ownerId: string): string {
  return `${bytesToHex(requestHash)}${bytesToHex(bs58.decode(ownerId))}`
}
