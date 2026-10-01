import type { AuthorDTO } from '../api/dto'

/**
 * `dm.*` DTOs (ENGINE.md §6.3 `dm`, §8). One surface for both backends: DM v5
 * (`lib/services/dm-v5`) on the devnet build, and legacy 1:1 messages
 * (`lib/services/direct-message-service.ts`, the v3 contract) on testnet.
 * Conversation keys are opaque: `d:…` / `g:…:…` for v5, `l:<conversationId>`
 * for legacy.
 */

export type DmBackendKind = 'v5' | 'legacy'

/** "Reclaim message fees" (docs/DM_V5.md §5.6): delete my sent messages once they are this old. */
export type DmRetention = '30d' | '90d' | '1y' | 'never'

export interface DmRecoveryDTO {
  /** The step shown under "Restoring your messages" (PRD DM-01). */
  phase: 'invites' | 'contacts-recent' | 'groups' | 'contacts-older'
  done: number
  total: number
  /** Conversations found so far. */
  found: number
}

export interface DmStatusDTO {
  backend: DmBackendKind
  /**
   * Signed in, but this device holds no encryption key for the identity, so
   * nothing can be read or sent (PRD DM-02): `dm.unlock`. v5 only.
   */
  locked: boolean
  /** v5: the saved state has loaded. Legacy: the conversation list has loaded once. */
  ready: boolean
  /** Unread messages in conversations that are not hidden. */
  unreadTotal: number
  /** Conversations with unread messages: the Messages badge (PRD DM-13). */
  unreadConversations: number
  /** v5: about 290 conversations are saved; newer ones show but are not saved for other devices. */
  capReached: boolean
  /** v5's "Reclaim message fees" setting; `null` on legacy. */
  retention: DmRetention | null
  /** v5: people blocked in Messages (kept in the encrypted self-state, separate from `safety.block`). */
  blocked: string[]
  /** v5 lost-state recovery on a new device, while it runs. */
  recovery: DmRecoveryDTO | null
  /** The last background poll failed with this; cleared by the next good one. */
  error: string | null
}

/** A conversation's preview line (PRD DM-01: "You: " prefix when `own`). */
export interface DmPreviewDTO {
  text: string
  at: Date
  own: boolean
}

export interface ConversationDTO {
  key: string
  backend: DmBackendKind
  kind: 'direct' | 'group'
  /** 1:1: the other person. `null` for a group. */
  peer: AuthorDTO | null
  /** Group: its owner. `null` for a 1:1. */
  ownerId: string | null
  /** Group: its name (may be empty). `null` for a 1:1. */
  name: string | null
  /** Group members (the owner included). Empty for a 1:1. */
  members: string[]
  isOwner: boolean
  lastMessage: DmPreviewDTO | null
  lastActivity: Date | null
  unread: number
  flags: {
    /** "Deleted" (v5 hide): it comes back when a newer message arrives. */
    hidden: boolean
    /** Group keys missing: ask the owner to resend them. */
    unreadable: boolean
    /** Removed from the group, or left it. */
    removed: boolean
    ended: boolean
    /** 1:1 with someone blocked in Messages. */
    blocked: boolean
    /** Found but not saved (the self-state cap). */
    unsaved: boolean
    /** Opened with `startDirect` and nothing sent yet: nothing is on chain. */
    draft: boolean
  }
  /** Legacy, with read receipts: when the other person last read it (PRD DM-11 "Read"). Known once opened. */
  peerReadAt: Date | null
}

export interface MessageDTO {
  /** Stable per message. */
  id: string
  sender: string
  text: string
  at: Date
  own: boolean
  /** v5: sent from this device and not yet read back from the chain. */
  pending: boolean
}

/** Group management (`dm.group`), one write ticket each. */
export type DmGroupAction =
  | { action: 'rename'; key: string; name: string }
  | { action: 'add' | 'remove' | 'resendKeys'; key: string; memberId: string }
  | { action: 'leave' | 'end'; key: string }

export interface DmEvents {
  /** Coalesced to at most one per 250 ms. `changedKeys` lists conversations added, changed or gone. */
  'dm.changed': { unreadTotal: number; unreadConversations: number; changedKeys: string[]; ready: boolean; error: string | null }
  /** A new incoming message (never `own`), once per message, for messages newer than the session start. */
  'dm.message': { key: string; message: MessageDTO }
}

/** What both backends answer; the module adds peers, paging, validation and tickets on top. */
export type ConversationRow = Omit<ConversationDTO, 'peer'> & { peerId: string | null }
