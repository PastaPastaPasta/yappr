/**
 * The live {@link AppConnectPorts} on the devnet SDK (evo-sdk 5.0.0-beta.4):
 * proved reads of identities, contracts and groups; the MASTER-signed
 * IdentityUpdate with V1 keys (`IdentityPublicKeyInCreation` with
 * `contractBounds`, `totalBudget` and `expiresAt`); IdentityKeyLimitsUpdate;
 * and the `loginKeyResponse` delete (indexOnly: a Document carrying all three
 * values) and create on the App Connect system contract. Logs carry ids only.
 */
import bs58 from 'bs58'
import { hexToBytes } from '@noble/hashes/utils.js'
import {
  ContractBounds,
  IdentityPublicKeyInCreation,
  type EvoSDK,
  type IdentityPublicKey,
} from '@dashevo/evo-sdk'
import type { AppConnectIdentityKey, AppConnectKeyBounds } from '../../../../vendor/platform-auth/src/app-connect/types'
import { getYapprPublicKey } from '../../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import {
  buildDocument,
  confirmedWrite,
  createDocument,
  fetchIdentity,
  poolKeyOnChain,
  requirePoolKey,
  withSigner,
} from '../platform'
import type { GrantStore } from './state'
import { APP_CONNECT_CONTRACT_ID, LOGIN_KEY_RESPONSE, bytesEqual, type AppConnectPorts } from './wallet'

/** How long a write whose confirmation timed out may take to show up before the answer fails. */
const VISIBILITY_TIMEOUT_MS = 90_000
const VISIBILITY_POLL_MS = 2_000

export function liveAppConnectPorts(sdk: EvoSDK, grants: GrantStore, log: (line: string) => void): AppConnectPorts {
  async function identityKeys(identityId: string): Promise<AppConnectIdentityKey[] | null> {
    const identity = await sdk.identities.fetch(identityId)
    return identity ? identity.publicKeys.map(toAppConnectKey) : null
  }

  /** Polls the identity's keys until `done` returns a value: a write whose wait timed out may still land. */
  async function waitForKeys<T>(identityId: string, what: string, done: (keys: AppConnectIdentityKey[]) => T | undefined): Promise<T> {
    const deadline = Date.now() + VISIBILITY_TIMEOUT_MS
    for (;;) {
      const result = done((await identityKeys(identityId)) ?? [])
      if (result !== undefined) return result
      if (Date.now() > deadline) throw new Error(`${what} is not visible on chain after ${VISIBILITY_TIMEOUT_MS / 1000} s`)
      await new Promise((resolve) => setTimeout(resolve, VISIBILITY_POLL_MS))
    }
  }

  return {
    grants,
    log,
    now: () => Date.now(),
    identityKeys,

    async contract(contractId) {
      const contract = await sdk.contracts.fetch(contractId)
      if (!contract) return null
      const config = contract.config
      return {
        ownerId: contract.ownerId.toBase58(),
        requiresIdentityEncryptionBoundedKey: config.requiresIdentityEncryptionBoundedKey ?? undefined,
        requiresIdentityDecryptionBoundedKey: config.requiresIdentityDecryptionBoundedKey ?? undefined,
      }
    },

    async groupOwner(groupId) {
      return (await sdk.contractGroups.info(groupId))?.ownerId ?? null
    },

    async contractKeys(identityId, contractId, purpose) {
      const results = await sdk.identities.contractKeys({ identityIds: [identityId], contractId, purposes: [purpose] })
      const entry = results.find((result) => result.identityId.toBase58() === identityId)
      return entry ? entry.keys.map(toAppConnectKey) : []
    },

    async updateIdentity(persona, update) {
      const identity = await fetchIdentity(sdk, persona)
      const master = persona.key('master')
      // Only the pool's own live MASTER key signs.
      requirePoolKey(identity, persona, master)
      const publicKeys = update.add.map((key) => getYapprPublicKey(key.privateKey))
      const addPublicKeys = update.add.map((key, index) => new IdentityPublicKeyInCreation({
        // The SDK numbers new keys from the identity's highest id.
        keyId: 0,
        purpose: key.purpose,
        securityLevel: key.securityLevel,
        keyType: 'ecdsa_secp256k1',
        data: publicKeys[index],
        contractBounds: key.bounds ? toContractBounds(key.bounds) : undefined,
        totalBudget: key.totalBudget,
        expiresAt: key.expiresAt === undefined ? undefined : BigInt(key.expiresAt),
      }))
      log(`IdentityUpdate for ${persona.identityId}: add ${update.add.length} key(s), disable [${update.disable.join(', ')}]`)
      try {
        // Each new ECDSA_SECP256K1 key signs its own registration, so the signer holds them too.
        await withSigner([master.privateKey, ...update.add.map((key) => key.privateKey)], (signer) =>
          confirmedWrite('IdentityUpdate', () =>
            sdk.identities.update({ identity, addPublicKeys, disablePublicKeys: update.disable, signer }), log))
      } finally {
        addPublicKeys.forEach((key) => key.free())
      }

      return waitForKeys(persona.identityId, 'IdentityUpdate', (keys) => {
        const disabled = update.disable.every((id) => keys.some((key) => key.id === id && key.disabledAt !== undefined))
        const ids = publicKeys.map((data) => keys.find((key) => bytesEqual(key.data, data))?.id)
        return disabled && ids.every((id) => id !== undefined) ? (ids as number[]) : undefined
      })
    },

    async raiseKeyLimits(persona, keyId, limits) {
      const identity = await fetchIdentity(sdk, persona)
      const master = persona.key('master')
      requirePoolKey(identity, persona, master)
      const before = identity.getPublicKeyById(keyId)?.totalBudget
      log(`IdentityKeyLimitsUpdate for ${persona.identityId} key ${keyId}`)
      await withSigner([master.privateKey], (signer) =>
        confirmedWrite('IdentityKeyLimitsUpdate', () =>
          sdk.identities.updateKeyLimits({
            identity,
            keyId,
            addBudget: limits.addBudget,
            expiresAt: limits.expiresAt === undefined ? undefined : BigInt(limits.expiresAt),
            signer,
          }), log))
      await waitForKeys(persona.identityId, `limits of key ${keyId}`, (keys) => {
        const key = keys.find((candidate) => candidate.id === keyId)
        if (!key) return undefined
        const budgetDone = limits.addBudget === undefined || before === undefined || key.totalBudget === before + limits.addBudget
        const expiryDone = limits.expiresAt === undefined || key.expiresAt === limits.expiresAt
        return budgetDone && expiryDone ? true : undefined
      })
    },

    async deleteResponse(persona, stored) {
      const high = persona.key('high')
      const identityKey = await poolKeyOnChain(sdk, persona, high)
      // indexOnly: the delete is by the entry's values, so the document carries all three.
      const document = buildDocument({
        contractId: APP_CONNECT_CONTRACT_ID,
        documentTypeName: LOGIN_KEY_RESPONSE,
        ownerId: persona.identityId,
        id: stored.documentId ? bs58.decode(stored.documentId) : crypto.getRandomValues(new Uint8Array(32)),
        revision: BigInt(1),
        fields: {
          appEphemeralPubKeyHash: hexToBytes(stored.appEphemeralPubKeyHash),
          walletEphemeralPubKey: hexToBytes(stored.walletEphemeralPubKey),
          encryptedPayload: hexToBytes(stored.encryptedPayload),
        },
      })
      log(`deleting ${LOGIN_KEY_RESPONSE} for request ${stored.appEphemeralPubKeyHash} with keyId ${identityKey.keyId}`)
      await withSigner([high.privateKey], (signer) => sdk.documents.delete({ document, identityKey, signer }))
    },

    async createResponse(persona, values) {
      const high = persona.key('high')
      const identityKey = await poolKeyOnChain(sdk, persona, high)
      log(`creating ${LOGIN_KEY_RESPONSE} for ${persona.identityId} with keyId ${identityKey.keyId}`)
      return withSigner([high.privateKey], (signer) => createDocument(sdk, {
        contractId: APP_CONNECT_CONTRACT_ID,
        documentTypeName: LOGIN_KEY_RESPONSE,
        ownerId: persona.identityId,
        fields: values,
        identityKey,
        signer,
        log,
      }))
    },
  }
}

function toAppConnectKey(key: IdentityPublicKey): AppConnectIdentityKey {
  const data = key.data as unknown
  return {
    id: key.keyId,
    type: key.keyTypeNumber,
    purpose: key.purposeNumber,
    securityLevel: key.securityLevelNumber,
    // wasm-dpp2 returns the key data as hex.
    data: typeof data === 'string' ? hexToBytes(data) : (data as Uint8Array),
    disabledAt: key.disabledAt === undefined ? undefined : Number(key.disabledAt),
    bounds: fromContractBounds(key.contractBounds),
    totalBudget: key.totalBudget,
    expiresAt: key.expiresAt === undefined ? undefined : Number(key.expiresAt),
  }
}

function fromContractBounds(bounds: ContractBounds | undefined): AppConnectKeyBounds | undefined {
  if (!bounds) return undefined
  const id = bounds.identifier.toBase58()
  switch (bounds.contractBoundsType) {
    case 'singleContract':
      return { kind: 'singleContract', contractId: id }
    case 'documentType':
      return { kind: 'documentType', contractId: id, documentTypeName: bounds.documentTypeName ?? '' }
    case 'contractGroup':
      return { kind: 'contractGroup', groupId: id }
    default:
      throw new Error(`unknown contract bounds type ${bounds.contractBoundsType}`)
  }
}

function toContractBounds(bounds: AppConnectKeyBounds): ContractBounds {
  switch (bounds.kind) {
    case 'singleContract':
      return ContractBounds.SingleContract(bounds.contractId)
    case 'documentType':
      return ContractBounds.SingleContractDocumentType(bounds.contractId, bounds.documentTypeName)
    case 'contractGroup':
      return ContractBounds.ContractGroup(bounds.groupId)
  }
}
