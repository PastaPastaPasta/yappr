/**
 * Query inspector record types.
 *
 * Everything stored here must be plain, JSON-safe data. Proof and metadata
 * come off wasm-bindgen objects that can be freed by GC finalization, so they
 * are serialized (hex / string / number) at capture time and never retained
 * as live handles.
 */

/** Every SDK facade the inspector instruments, in panel order. */
export const INSPECTOR_FACADES = [
  'documents',
  'identities',
  'contracts',
  'dpns',
  'tokens',
  'epoch',
  'protocol',
  'system',
  'voting',
  'group',
  'addresses',
  'shielded',
  'stateTransitions',
] as const

export type InspectorFacade = (typeof INSPECTOR_FACADES)[number]

export type ProofStatus = 'proven' | 'unavailable' | 'proof-failed'

export interface ProofDetails {
  /** bincode-encoded GroveDB proof, hex */
  grovedbProofHex: string
  grovedbProofBytes: number
  quorumHashHex: string
  /** BLS threshold signature over the block, hex */
  signatureHex: string
  round: number
  blockIdHashHex: string
  quorumType: number
}

export interface ResponseMetadataDetails {
  /** Platform block height (bigint, stringified) */
  height: string
  coreChainLockedHeight: number
  epoch: number
  /** Block time in ms since epoch (bigint, stringified) */
  timeMs: string
  protocolVersion: number
  chainId: string
}

export interface QueryRecord {
  id: string
  seq: number
  timestamp: number
  durationMs: number
  facade: InspectorFacade
  /** e.g. "documents.query" */
  method: string
  kind: 'read' | 'write'
  params: unknown
  status: 'ok' | 'error'
  error?: string
  result?: unknown
  resultSummary: string
  metadata?: ResponseMetadataDetails
  proof?: ProofDetails
  proofStatus: ProofStatus
  /** Set when the proof-carrying call failed and the plain call was used instead */
  proofError?: string
}
