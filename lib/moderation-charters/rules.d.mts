export declare const CHARTERS_CONTRACT_ID: string
export declare const CONTEST_FUND_CREDITS: bigint
export declare const LEADER_MINIMUM_CREDITS: bigint
export declare const MEMBER_MINIMUM_CREDITS: bigint
export declare const CHARTER_LIMITS: Readonly<{
  descriptionBytes: number
  reasons: number
  members: number
  messageBytes: number
  reasonLabelChars: number
  reasonDescriptionChars: number
}>

export declare function utf8Bytes(text: string): number

export interface RewardSplit {
  leader: number
  equal: number
  actions: number
}
export declare const DEFAULT_REWARD_SPLIT: Readonly<RewardSplit>
export declare const DEFAULT_MODERATORS_SHARE: number

export interface ReasonDraft {
  code: string
  label: string
  description?: string
}

export type CharterTermsField = 'description' | 'reasons' | 'moderatorsShare' | 'rewardSplit'
export interface FieldProblem<F extends string> {
  field: F
  message: string
}

export declare function reasonProblem(reason: ReasonDraft | null | undefined): FieldProblem<'code' | 'label' | 'description'> | null

export interface CharterTerms<R = unknown> {
  description: string
  reasons: readonly R[]
  moderatorsShare: number
  rewardSplit: RewardSplit
}
export declare function charterTermsProblems<R>(terms: CharterTerms<R>, key?: (reason: R) => unknown): FieldProblem<CharterTermsField>[]

export declare function messageProblem(message: unknown): string | null

export type CharterKeyPurpose = 'ENCRYPTION' | 'DECRYPTION'
export type CharterKeyDocumentType = 'joinRequest' | 'submittedCharter'
/** The fields `isCharterKey` reads off an SDK identity public key. */
export interface CharterKeyLike {
  disabledAt?: unknown
  purpose?: unknown
  securityLevel?: unknown
  keyType?: unknown
  contractBounds?: { toJSON?: () => unknown } | null
}
export declare function isCharterKey(key: CharterKeyLike | null | undefined, purpose: CharterKeyPurpose, documentType: CharterKeyDocumentType): boolean
export declare const CHARTER_KEYS: Readonly<{
  leader: Readonly<{ purpose: 'DECRYPTION'; documentType: 'submittedCharter' }>
  member: Readonly<{ purpose: 'ENCRYPTION'; documentType: 'joinRequest' }>
}>

export declare function electionOpensAtMs(creationTimeMs: number | bigint | string | null | undefined, delaySeconds: number | null | undefined): number | null
export declare function joinClosesAtMs(pollEndsAtMs: number | null | undefined, contenders: number, voteWindowSeconds: number): number | null

export type ContestPhase = 'seated' | 'decided' | 'none' | 'joining' | 'voting' | 'unknown'
export declare function contestPhase(input: {
  seated: boolean
  decided: boolean
  contenders: number
  joinClosesAtMs: number | null | undefined
  chainTimeMs: number
}): ContestPhase

export declare function assertContestFund(credits: bigint | number | null | undefined): void
export declare function redactSecrets(text: unknown): string
