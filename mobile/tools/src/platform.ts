/**
 * The live {@link ResponderPorts}: a devnet SDK built by the repo's own
 * `scripts/sdk-env.mjs` (trusted mode plus its DAPI path shim), the
 * `loginKeyResponse` write on the key-exchange contract, and the `dash-st:`
 * broadcast. Logs carry ids and key ids only.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import bs58 from 'bs58'
import {
  Document,
  IdentitySigner,
  PlatformVersion,
  PrivateKey,
  type DocumentObject,
  type EvoSDK,
  type IdentityPublicKey,
} from '@dashevo/evo-sdk'
import type { LoginKeyResponseFields } from './key-exchange'
import type { Persona, PersonaKey } from './pool'
import type { DevnetConfig, ResponderConfig } from './config'
import { requireKeyExchangeContract } from './config'
import { isStaleIdentityNonce, NONCE_SEQUENCE_MASK } from './dash-st'
import { isTimeout } from './errors'
import type { ResponderPorts } from './responder'

const LOGIN_KEY_RESPONSE = 'loginKeyResponse'
const SDK_TIMEOUT_MS = 30_000

interface SdkEnvModule {
  devnetSdk(options: { timeoutMs?: number; config: DevnetConfig }): EvoSDK
}

export async function connectDevnet(repoRoot: string, devnet: DevnetConfig): Promise<EvoSDK> {
  const sdkEnv = (await import(pathToFileURL(join(repoRoot, 'scripts/sdk-env.mjs')).href)) as SdkEnvModule
  const sdk = sdkEnv.devnetSdk({ timeoutMs: SDK_TIMEOUT_MS, config: devnet })
  await sdk.connect()
  return sdk
}

export function livePorts(sdk: EvoSDK, config: ResponderConfig, log: (line: string) => void): ResponderPorts {
  /** The on-chain key matching `poolKey`, which must be live. */
  async function onChainKey(persona: Persona, poolKey: PersonaKey): Promise<IdentityPublicKey> {
    const identity = await sdk.identities.fetch(persona.identityId)
    if (!identity) throw new Error(`Identity ${persona.identityId} not found on devnet ${config.devnet.devnetName}`)
    const key = identity.getPublicKeyById(poolKey.keyId)
    if (!key || key.disabledAt !== undefined || !key.validatePrivateKey(poolKey.privateKey, 'testnet')) {
      throw new Error(`Identity ${persona.identityId} keyId ${poolKey.keyId} is missing, disabled, or not the pool's key`)
    }
    return key
  }

  /** Runs `wait`; a timeout after the broadcast counts as unconfirmed, not failed. */
  async function confirmed(what: string, wait: () => Promise<unknown>): Promise<boolean> {
    try {
      await wait()
      return true
    } catch (error) {
      if (!isTimeout(error)) throw error
      log(`${what}: confirmation timed out; it may still land`)
      return false
    }
  }

  return {
    async findLoginKeyResponse(persona, appContractId) {
      const results = await sdk.documents.query({
        dataContractId: requireKeyExchangeContract(config),
        documentTypeName: LOGIN_KEY_RESPONSE,
        where: [
          ['$ownerId', '==', persona.identityId],
          ['contractId', '==', bs58.encode(appContractId)],
        ],
        limit: 1,
      })
      for (const document of results.values()) {
        if (!document) continue
        return {
          documentId: document.id.toBase58(),
          revision: document.revision ?? BigInt(1),
          keyIndex: Number(document.properties.keyIndex),
        }
      }
      return undefined
    },

    async writeLoginKeyResponse(persona, fields, existing) {
      const contractId = requireKeyExchangeContract(config)
      const high = persona.key('high')
      const identityKey = await onChainKey(persona, high)
      const signer = new IdentitySigner()
      const privateKey = PrivateKey.fromBytes(high.privateKey, 'testnet')
      try {
        signer.addKey(privateKey)
        if (existing) {
          // One response per (owner, app contract): a re-login replaces it
          // (spec §7.3; every wallet does the same).
          const revision = existing.revision + BigInt(1)
          const document = buildDocument({ contractId, ownerId: persona.identityId, id: bs58.decode(existing.documentId), revision, fields })
          log(`replacing ${LOGIN_KEY_RESPONSE} ${existing.documentId} (revision ${revision}) with keyId ${identityKey.keyId}`)
          const ok = await confirmed(`replace ${existing.documentId}`, () => sdk.documents.replace({ document, identityKey, signer }))
          return { documentId: existing.documentId, action: 'replaced', confirmed: ok }
        }
        // From protocol 14 the id commits to the contract nonce. The SDK
        // re-derives it when it builds the transition, so this one is only
        // reported if the confirmation wait times out.
        const entropy = crypto.getRandomValues(new Uint8Array(32))
        const nonce = ((await sdk.identities.contractNonce(persona.identityId, contractId)) ?? BigInt(0)) & NONCE_SEQUENCE_MASK
        const id = Document.generateId(LOGIN_KEY_RESPONSE, persona.identityId, contractId, entropy, nonce + BigInt(1))
        const document = buildDocument({ contractId, ownerId: persona.identityId, id, revision: BigInt(1), entropy, fields })
        log(`creating ${LOGIN_KEY_RESPONSE} with keyId ${identityKey.keyId}`)
        let documentId = bs58.encode(id)
        const ok = await confirmed(`create ${documentId}`, async () => {
          documentId = (await sdk.documents.create({ document, identityKey, signer })).id.toBase58()
        })
        return { documentId, action: 'created', confirmed: ok }
      } finally {
        privateKey.free()
        signer.free()
      }
    },

    masterKey(persona) {
      return onChainKey(persona, persona.key('master'))
    },

    async checkIdentityUpdate(persona, stateTransition) {
      const current = (await sdk.identities.nonce(persona.identityId)) ?? BigInt(0)
      const carried = stateTransition.identityNonce ?? BigInt(0)
      if (isStaleIdentityNonce(carried, current)) {
        throw new Error(
          `dash-st: stale transition (identity nonce ${carried} is not past the current ${current}); rebuild the request`,
        )
      }
    },

    async broadcast(stateTransition) {
      const transitionHash = stateTransition.hash(false)
      await sdk.stateTransitions.broadcastStateTransition(stateTransition)
      log(`broadcast IdentityUpdate ${transitionHash}`)
      const ok = await confirmed(`IdentityUpdate ${transitionHash}`, () => sdk.stateTransitions.waitForResponse(stateTransition))
      return { transitionHash, confirmed: ok }
    },
  }
}

function buildDocument(input: {
  contractId: string
  ownerId: string
  id: Uint8Array
  revision: bigint
  entropy?: Uint8Array
  fields: LoginKeyResponseFields
}): Document {
  // Document.fromObject keeps Uint8Array fields as bytes; the constructor
  // does not (lib/services/document-builder-service.ts).
  return Document.fromObject(
    {
      $formatVersion: '0',
      $id: input.id,
      $ownerId: bs58.decode(input.ownerId),
      $dataContractId: bs58.decode(input.contractId),
      $type: LOGIN_KEY_RESPONSE,
      $revision: input.revision,
      ...(input.entropy ? { $entropy: input.entropy } : {}),
      ...input.fields,
    } as unknown as DocumentObject,
    PlatformVersion.current(),
  )
}
