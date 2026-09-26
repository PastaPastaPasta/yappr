import type { EvoSDK } from '@dashevo/evo-sdk'

/**
 * Every EvoSDK facade the app routes DAPI calls through, in inspector panel
 * order. The query inspector and the failure observer both shadow the methods
 * on these objects, so the list lives in one place and neither can silently
 * miss a facade the other covers. Calls on the raw wasm handle (`sdk.wasm.*`)
 * bypass the facades and both wrappers.
 */
export const SDK_FACADES = [
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
  'contractGroups',
  'moderationCharters',
  'encryptedFor',
  'addresses',
  'shielded',
  'stateTransitions',
] as const satisfies readonly (keyof EvoSDK)[]

export type SdkFacade = (typeof SDK_FACADES)[number]
