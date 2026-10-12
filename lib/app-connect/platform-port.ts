import bs58 from 'bs58'
import type {
  AppConnectCandidate,
  AppConnectGroupInfo,
  AppConnectGroupMember,
  AppConnectIdentityKey,
  AppConnectIdentityPort,
  AppConnectResponsePort,
} from 'platform-auth'
import type { DocumentWhereClause } from '@dashevo/wasm-sdk'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import { bytesToBase64, requireBytes } from '@/lib/bytes'
import { APP_CONNECT_RESPONSE_CONTRACT_ID, APP_CONNECT_RESPONSE_DOCUMENT_TYPE } from './config'
import type { MemberContractPort } from './group-trust'
import { toAppConnectIdentityKeys, type WasmIdentityKeyLike } from './key-mapping'
import { documentToPlainObject } from '@/lib/services/sdk-helpers'

/**
 * App Connect's chain reads over the evo-sdk. Every method is a proved read
 * (the SDK's default facade methods verify proofs), and identity reads go to
 * the network directly, bypassing the app's identity cache: a key added
 * moments ago is exactly what the verifier checks.
 */

type GroupMemberKind = 'contracts' | 'documentTypes' | 'tokens'
const MEMBER_PAGE = 100

/** Block time and protocol version from the latest proved response. */
export interface AppConnectChainStatus {
  protocolVersion: number
  blockTimeMs: number
}

export interface AppConnectPlatformPort extends AppConnectIdentityPort, AppConnectResponsePort, MemberContractPort {
  chainStatus(): Promise<AppConnectChainStatus>
}

async function groupMembers(groupId: string): Promise<AppConnectGroupMember[]> {
  const sdk = await getEvoSdk()
  const members: AppConnectGroupMember[] = []
  for (const kind of ['contracts', 'documentTypes', 'tokens'] as GroupMemberKind[]) {
    let startAfter: { contractId: string; documentTypeName?: string; tokenPosition?: number } | undefined
    for (;;) {
      const page = await sdk.contractGroups.members({ contractGroupId: groupId, kind, limit: MEMBER_PAGE, ...(startAfter ? { startAfter } : {}) })
      for (const contractId of page.contracts ?? []) members.push({ kind: 'contract', contractId })
      for (const entry of page.documentTypes ?? []) {
        members.push({ kind: 'documentType', contractId: entry.contractId, documentTypeName: entry.documentTypeName })
      }
      for (const entry of page.tokens ?? []) members.push({ kind: 'token', contractId: entry.contractId, position: entry.tokenPosition })
      if (!page.nextStartAfter) break
      startAfter = page.nextStartAfter
    }
  }
  return members
}

export const appConnectPlatformPort: AppConnectPlatformPort = {
  async getIdentityFresh(identityId) {
    const sdk = await getEvoSdk()
    const identity = await sdk.identities.fetch(identityId)
    if (!identity) return null
    return {
      id: identity.id.toBase58(),
      publicKeys: toAppConnectIdentityKeys(identity.publicKeys as unknown as WasmIdentityKeyLike[]),
    }
  },

  async remainingBudgets(identityId, keyIds) {
    const sdk = await getEvoSdk()
    const budgets = await sdk.identities.keysRemainingBudgets(identityId, keyIds)
    const result = new Map<number, bigint | undefined>()
    for (const [keyId, remaining] of budgets) result.set(Number(keyId), remaining ?? undefined)
    return result
  },

  async contractKeys(identityId, contractId, purpose): Promise<AppConnectIdentityKey[]> {
    const sdk = await getEvoSdk()
    const entries = await sdk.identities.contractKeys({ identityIds: [identityId], contractId, purposes: [purpose] })
    const entry = entries.find((candidate) => candidate.identityId.toBase58() === identityId)
    return entry ? toAppConnectIdentityKeys(entry.keys as unknown as WasmIdentityKeyLike[]) : []
  },

  async groupInfo(groupId): Promise<AppConnectGroupInfo | null> {
    const sdk = await getEvoSdk()
    const info = await sdk.contractGroups.info(groupId)
    if (!info) return null
    return { ownerId: info.ownerId, adminIds: [...info.adminIds], members: await groupMembers(groupId) }
  },

  async memberContract(contractId) {
    const sdk = await getEvoSdk()
    const contract = await sdk.contracts.fetch(contractId)
    return contract ? { version: contract.version, ownerId: contract.ownerId.toBase58() } : null
  },

  async listCandidates(requestHash, hint, startAfter, limit): Promise<AppConnectCandidate[]> {
    const sdk = await getEvoSdk()
    // indexOnly: entries are keyed (appEphemeralPubKeyHash, $ownerId) and the
    // synthesized $id is no cursor, so pages continue after the last owner.
    const where: DocumentWhereClause[] = [['appEphemeralPubKeyHash', '==', bytesToBase64(requestHash)]]
    if (hint) where.push(['$ownerId', '==', hint])
    else if (startAfter) where.push(['$ownerId', '>', startAfter])
    const response = await sdk.documents.query({
      dataContractId: APP_CONNECT_RESPONSE_CONTRACT_ID,
      documentTypeName: APP_CONNECT_RESPONSE_DOCUMENT_TYPE,
      where,
      orderBy: [['$ownerId', 'asc']],
      limit,
    })
    const candidates: AppConnectCandidate[] = []
    for (const document of response.values()) {
      if (!document) continue
      const plain = documentToPlainObject(document)
      const ownerId = plain.$ownerId
      if (typeof ownerId !== 'string') continue
      try {
        candidates.push({
          ownerId,
          walletEphemeralPubKey: requireBytes(plain.walletEphemeralPubKey, 'walletEphemeralPubKey'),
          encryptedPayload: requireBytes(plain.encryptedPayload, 'encryptedPayload'),
        })
      } catch {
        // A malformed entry is just not a candidate.
      }
    }
    // The poller relies on owner order; Platform returns it, but a Map's order is the SDK's.
    return candidates.sort((a, b) => compareIds(a.ownerId, b.ownerId))
  },

  async chainStatus() {
    const sdk = await getEvoSdk()
    const { metadata } = await sdk.protocol.versionUpgradeStateWithProof()
    return { protocolVersion: metadata.protocolVersion, blockTimeMs: Number(metadata.timeMs) }
  },
}

function compareIds(a: string, b: string): number {
  const left = bs58.decode(a)
  const right = bs58.decode(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return left.length - right.length
}
