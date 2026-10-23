import type * as Wasm from '@dashevo/wasm-sdk'
import type { EvoSDK } from '@dashevo/evo-sdk'

/** The wasm classes the builders use: the app's `@dashevo/wasm-sdk` or the CLI's `@dashevo/evo-sdk`, which re-exports them. */
type WasmModule = Pick<typeof Wasm,
  | 'Identifier' | 'Document' | 'PlatformVersion' | 'DocumentCreateTransition' | 'PrefundedVotingBalance'
  | 'BatchTransition' | 'BatchedTransition' | 'IdentityPublicKeyInCreation' | 'ContractBounds'>


export type CharterDocumentType =
  | 'reason'
  | 'submittedCharter'
  | 'joinRequest'
  | 'electedCharter'
  | 'addedModerator'
  | 'removedModerator'
  | 'resignationRequest'

/** A signed charters create, ready to broadcast (and to broadcast again, unchanged). */
export interface SignedCharterCreate {
  id: string
  type: CharterDocumentType
  owner: string
  nonce: string
  bytes: Uint8Array
  hash: string
}

export declare function nextCharterNonce(sdk: EvoSDK, ownerId: string, floor?: bigint): Promise<bigint>
export declare function charterNonceConsumed(sdk: EvoSDK, ownerId: string, nonce: bigint | string): Promise<boolean>

export declare function signCharterCreate(w: WasmModule, sdk: EvoSDK, options: {
  type: CharterDocumentType
  ownerId: string
  data: Record<string, unknown>
  nonce: bigint
  privateKey: Wasm.PrivateKey
  identityKey: Wasm.IdentityPublicKey
  fund?: boolean
}): Promise<SignedCharterCreate>

export declare function charterKeyInCreation(w: WasmModule, options: {
  keyId: number
  purpose: 'ENCRYPTION' | 'DECRYPTION'
  documentType: 'joinRequest' | 'submittedCharter'
  publicKey: Uint8Array
}): Wasm.IdentityPublicKeyInCreation

export declare function charterStepExists(
  w: WasmModule,
  sdk: EvoSDK,
  step: { id: string; type: CharterDocumentType; owner: string },
  targetContractId: string,
): Promise<boolean>

export declare function charterIdBytes(w: WasmModule, id: string): Uint8Array
