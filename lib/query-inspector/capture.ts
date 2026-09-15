/**
 * SDK instrumentation for the query inspector.
 *
 * `instrumentSdk` shadows every facade method on a freshly constructed EvoSDK
 * instance. When the inspector is enabled, reads are routed through their
 * `*WithProof` sibling so the GroveDB proof and response metadata — already
 * fetched and verified over the wire — are captured instead of discarded; the
 * caller still receives the exact same value (`response.data`). When the
 * inspector is disabled, calls pass straight through to the original method.
 *
 * Capture must never change app behavior: a failure on the proof-carrying
 * path falls back to the plain call, and failures inside recording itself are
 * swallowed and logged at debug level.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { logger } from '@/lib/logger'
import { bytesToHex, errorText, summarizeResult, toBoundedPlain, toPlain } from './serialize'
import { inspectorIsCapturing, recordQuery } from './store'
import { INSPECTOR_FACADES } from './types'
import type {
  InspectorFacade,
  ProofDetails,
  QueryRecord,
  ResponseMetadataDetails,
} from './types'

const WRITE_METHODS = new Set([
  'documents.create',
  'documents.replace',
  'documents.delete',
  'documents.transfer',
  'documents.purchase',
  'documents.setPrice',
  'identities.create',
  'identities.topUp',
  'identities.creditTransfer',
  'identities.creditWithdrawal',
  'identities.update',
  'contracts.publish',
  'contracts.update',
  'dpns.registerName',
  'tokens.mint',
  'tokens.burn',
  'tokens.transfer',
  'tokens.freeze',
  'tokens.unfreeze',
  'tokens.destroyFrozen',
  'tokens.emergencyAction',
  'tokens.setPrice',
  'tokens.directPurchase',
  'tokens.claim',
  'tokens.configUpdate',
  'voting.masternodeVote',
  'addresses.transfer',
  'addresses.topUpIdentity',
  'addresses.withdraw',
  'addresses.transferFromIdentity',
  'addresses.fundFromAssetLock',
  'addresses.createIdentity',
])

// Pure local wasm computations — no DAPI round-trip, not worth recording.
// (isContestedUsername checks the label against static contest rules; observed 0ms.)
const SKIP_METHODS = new Set([
  'dpns.convertToHomographSafe',
  'dpns.isValidUsername',
  'dpns.isContestedUsername',
  'tokens.calculateId',
])

// Known coverage gaps: calls made on the raw wasm handle bypass the facades and
// this net entirely — state-transition-service's refreshIdentityNonce /
// getIdentityContractNonce reads (`sdk.wasm.*`) and tip-service's standalone
// `wallet` namespace import. Route new code through the facades to stay visible.

interface WasmProofInfo {
  grovedbProof: Uint8Array
  quorumHash: Uint8Array
  signature: Uint8Array
  round: number
  blockIdHash: Uint8Array
  quorumType: number
}

interface WasmResponseMetadata {
  height: bigint
  coreChainLockedHeight: number
  epoch: number
  timeMs: bigint
  protocolVersion: number
  chainId: Uint8Array
}

interface WasmProofResponse {
  data: unknown
  metadata: WasmResponseMetadata
  proof: WasmProofInfo
}

type FacadeMethod = (...args: unknown[]) => Promise<unknown>

const instrumented = new WeakSet<object>()
let seqCounter = 0

export function instrumentSdk(sdk: EvoSDK): void {
  if (instrumented.has(sdk)) return
  instrumented.add(sdk)

  const sdkRecord = sdk as unknown as Record<InspectorFacade, unknown>
  for (const facadeName of INSPECTOR_FACADES) {
    const facade = sdkRecord[facadeName]
    if (!facade || typeof facade !== 'object') continue
    try {
      instrumentFacade(facadeName, facade as Record<string, unknown>)
    } catch (error) {
      logger.debug(`Query inspector: failed to instrument ${facadeName} facade`, error)
    }
  }
}

function instrumentFacade(facadeName: InspectorFacade, facade: Record<string, unknown>): void {
  const proto = Object.getPrototypeOf(facade) as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || name.endsWith('WithProof')) continue
    if (SKIP_METHODS.has(`${facadeName}.${name}`)) continue
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (!descriptor || typeof descriptor.value !== 'function') continue

    const original = descriptor.value as FacadeMethod
    const proofSibling = proto[`${name}WithProof`]
    const withProof = typeof proofSibling === 'function' ? (proofSibling as FacadeMethod) : null

    Object.defineProperty(facade, name, {
      value: makeWrapper(facadeName, name, facade, original, withProof),
      writable: true,
      configurable: true,
    })
  }
}

function makeWrapper(
  facadeName: InspectorFacade,
  name: string,
  facade: Record<string, unknown>,
  original: FacadeMethod,
  withProof: FacadeMethod | null
): FacadeMethod {
  const method = `${facadeName}.${name}`
  const kind: QueryRecord['kind'] =
    facadeName === 'stateTransitions' || WRITE_METHODS.has(method) ? 'write' : 'read'

  return async function wrapped(...args: unknown[]): Promise<unknown> {
    if (!inspectorIsCapturing()) {
      return original.apply(facade, args)
    }

    const started = performance.now()
    const base = {
      id: `${Date.now()}-${++seqCounter}`,
      seq: seqCounter,
      timestamp: Date.now(),
      facade: facadeName,
      method,
      kind,
      params: toPlain(args.length === 1 ? args[0] : args),
    }

    if (withProof && kind === 'read') {
      let response: WasmProofResponse
      try {
        response = (await withProof.apply(facade, args)) as WasmProofResponse
      } catch (proofPathError) {
        // The proof-carrying call failed. The app must not break because the
        // inspector is on, so retry on the plain path and record both outcomes.
        const proofError = errorText(proofPathError)
        try {
          const result = await original.apply(facade, args)
          safeRecord({
            ...base,
            durationMs: performance.now() - started,
            ...okOutcome(result),
            proofStatus: 'proof-failed',
            proofError,
          })
          return result
        } catch (plainError) {
          safeRecord({
            ...base,
            durationMs: performance.now() - started,
            ...errorOutcome(plainError),
            proofStatus: 'proof-failed',
            proofError,
          })
          throw plainError
        }
      }

      const data = response.data
      const proof = extractProof(response)
      safeRecord({
        ...base,
        durationMs: performance.now() - started,
        ...okOutcome(data),
        metadata: extractMetadata(response),
        proof,
        proofStatus: proof ? 'proven' : 'proof-failed',
        proofError: proof ? undefined : 'Proof fields could not be read from the response',
      })
      return data
    }

    try {
      const result = await original.apply(facade, args)
      safeRecord({
        ...base,
        durationMs: performance.now() - started,
        ...okOutcome(result),
        proofStatus: 'unavailable',
      })
      return result
    } catch (error) {
      safeRecord({
        ...base,
        durationMs: performance.now() - started,
        ...errorOutcome(error),
        proofStatus: 'unavailable',
      })
      throw error
    }
  }
}

/**
 * Result fields for a successful call. Serialization happens here, so callers
 * must compute `durationMs` before spreading this in — otherwise the recorded
 * duration would include the cost of capturing.
 */
function okOutcome(result: unknown): Pick<QueryRecord, 'status' | 'result' | 'resultSummary'> {
  return {
    status: 'ok',
    result: toBoundedPlain(result),
    resultSummary: summarizeResult(result),
  }
}

function errorOutcome(error: unknown): Pick<QueryRecord, 'status' | 'error' | 'resultSummary'> {
  return {
    status: 'error',
    error: errorText(error),
    resultSummary: 'error',
  }
}

function safeRecord(entry: QueryRecord): void {
  try {
    recordQuery(entry)
  } catch (error) {
    logger.debug('Query inspector: failed to record entry', error)
  }
}

function extractProof(response: WasmProofResponse): ProofDetails | undefined {
  try {
    const proof = response.proof
    return {
      grovedbProofHex: bytesToHex(proof.grovedbProof),
      grovedbProofBytes: proof.grovedbProof.length,
      quorumHashHex: bytesToHex(proof.quorumHash),
      signatureHex: bytesToHex(proof.signature),
      round: proof.round,
      blockIdHashHex: bytesToHex(proof.blockIdHash),
      quorumType: proof.quorumType,
    }
  } catch (error) {
    logger.debug('Query inspector: failed to extract proof', error)
    return undefined
  }
}

function extractMetadata(response: WasmProofResponse): ResponseMetadataDetails | undefined {
  try {
    const metadata = response.metadata
    return {
      height: metadata.height.toString(),
      coreChainLockedHeight: metadata.coreChainLockedHeight,
      epoch: metadata.epoch,
      timeMs: metadata.timeMs.toString(),
      protocolVersion: metadata.protocolVersion,
      chainId: decodeChainId(metadata.chainId),
    }
  } catch (error) {
    logger.debug('Query inspector: failed to extract metadata', error)
    return undefined
  }
}

function decodeChainId(chainId: Uint8Array): string {
  try {
    const text = new TextDecoder().decode(chainId)
    if (/^[\x20-\x7e]+$/.test(text)) return text
  } catch {
    // fall through to hex
  }
  return bytesToHex(chainId)
}
