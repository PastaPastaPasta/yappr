/**
 * Shared types for DM v5 (docs/DM_V5.md). Identity ids, keys and handles are
 * raw bytes throughout: identity ids are the 32-byte Platform identifiers,
 * never base58 strings.
 */

/** A 32-byte Platform identity id. */
export type IdentityId = Uint8Array

/** A group key epoch: base `b` (bumped on removal) and ratchet step `r` (bumped on add). Both u16. */
export interface Epoch {
  b: number
  r: number
}

/** Points at one message in a sender's stream: week, epoch and index within the week (§6.1). */
export interface MessagePointer extends Epoch {
  w: number
  j: number
}

/** The on-chain fields of a `dmInvite` (§5.1). */
export interface DmInvite {
  bucket: number
  epk: Uint8Array
  check: Uint8Array
}

/** A group key handed to a member in a `0x05` grant (§6.2). */
export interface GroupGrant extends Epoch {
  gid: Uint8Array
  key: Uint8Array
}

/** Decoded message content (§6.2). Unknown types are surfaced, not rejected, so newer clients can add types. */
export type DmContent =
  | { type: 'text'; text: string }
  | { type: 'leave' }
  | { type: 'grant'; grant: GroupGrant }
  | { type: 'unknown'; code: number; payload: Uint8Array }

/** A decrypted message: the sender's previous message (null for the first) and its content. */
export interface DmPlaintext {
  prev: MessagePointer | null
  content: DmContent
}

/** A group member as the owner sees it when wrapping keyring slots. */
export interface KeyringMember {
  id: IdentityId
  publicKey: Uint8Array
}

/** Decrypted roster content (§5.4). `members` includes the owner. */
export interface RosterContent extends Epoch {
  name: string
  avatarRef: string
  members: IdentityId[]
  ended: boolean
}

/** A roster opened by ratcheting forward from a known key (§5.4). */
export interface OpenedRoster {
  content: RosterContent
  /** The key `K[b, r]` that decrypted it. */
  key: Uint8Array
}

export interface DirectConversation {
  peer: IdentityId
  /** Week the conversation started. */
  since: number
  /** A `$createdAt` in ms: everything newer is unread. */
  readAt: number
  /** "Delete conversation" time in ms, 0 if never: a newer message un-hides it. */
  hiddenAt: number
}

export interface GroupConversation {
  gid: Uint8Array
  owner: IdentityId
  /** The earliest group key the user was granted, and its epoch. */
  earliestEpoch: Epoch
  earliestKey: Uint8Array
  since: number
  readAt: number
  hiddenAt: number
}

/** A block-list entry. Unblocking keeps the entry with `blocked: false`, so the unblock survives a merge. */
export interface BlockEntry {
  id: IdentityId
  blocked: boolean
  /** When it was last blocked or unblocked (ms); the newer change wins a merge. */
  changedAt: number
}

export type RetentionSetting = '30d' | '90d' | '1y' | 'never'

export interface DmSettings {
  retention: RetentionSetting
  /** When the settings were last changed (ms); the newer save wins a merge. */
  updatedAt: number
}

/** The decrypted `dmSelfState` (§5.5). */
export interface SelfState {
  directs: DirectConversation[]
  groups: GroupConversation[]
  blocks: BlockEntry[]
  settings: DmSettings
  /** The `$createdAt` (ms) of the newest invite whose conversation is saved. */
  inviteScanCursor: number
  /** The next group number `n` this user will create as owner. */
  nextGroupNumber: number
  /** Past encryption private keys (Appendix A). Always empty in Phase 1. */
  pastKeys: Uint8Array[]
}
